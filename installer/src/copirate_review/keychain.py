"""Read credentials out of the macOS keychain without the value entering this process.

Every credential flows keychain → consumer over an OS pipe. It is never bound to a
Python name, never passed in argv, never logged, and never returned from any function
here. This module orchestrates the pipe; it cannot observe what travels through it.
[LAW:effects-at-boundaries]
"""

from __future__ import annotations

import subprocess
import tempfile

from .shell import EffectError

_FIND = ["security", "find-generic-password", "-s"]

#: `security`'s exit status for errSecItemNotFound, and the ONLY nonzero one that means
#: the item is absent. Measured, not assumed: `security find-generic-password -s <no
#: such item>` exits 44.
ITEM_NOT_FOUND = 44


def has_item(item: str) -> bool:
    """Whether this machine holds the named generic-password item.

    Three answers, not two: found, absent, and *could not tell* — a locked keychain, a
    denied ACL, a cancelled authorization prompt. Only the second is a `False`. Reading
    the exit status as a mere boolean folds the third into "absent", and the caller then
    reports a credential MISSING and tells the operator to add a keychain item they are
    looking at right now, while the real cause — a locked keychain — goes unnamed.
    [LAW:types-are-the-program] [LAW:no-silent-failure]
    """
    result = subprocess.run([*_FIND, item], capture_output=True, text=True)
    if result.returncode == 0:
        return True
    if result.returncode == ITEM_NOT_FOUND:
        return False
    detail = (result.stderr or result.stdout).strip()
    raise EffectError(
        f"could not read keychain item {item!r}: `security` exited {result.returncode}"
        f"{f' — {detail}' if detail else ''}. If the keychain is locked, unlock it and "
        f"re-run; this is not the same as the item being absent."
    )


def pipe_into(item: str, argv: list[str]) -> str:
    """Stream the item's value, newline-stripped, into `argv`'s stdin; return its stdout.

    ONE pipeline, which every reader of a keychain item goes through. `security … -w`
    appends a newline to whatever it prints, and that newline is the whole reason the
    `tr` stage exists — a second pipeline built beside this one is a second place that
    has to know, and the one that forgets reads an empty item as one byte of content.
    [LAW:one-source-of-truth]

    `tr` is a separate process for the same reason the whole chain is: stripping the
    newline in Python would mean reading the credential into this process's memory.

    Only ONE pipe in the chain is ever read by this process, and it is read last. So
    every other stream the chain produces goes somewhere that cannot fill and block: the
    reader's stderr to a temporary file, `tr`'s to /dev/null. A pipe nobody drains until
    the chain finishes is a pipe the chain can deadlock on — `security` cannot exit
    until its stderr is drained, `tr` cannot see end-of-input until `security` exits,
    and the consumer cannot exit until `tr` does, so the one read we do would wait
    forever on a process waiting on us. [LAW:no-ambient-temporal-coupling]
    """
    with tempfile.TemporaryFile() as find_errors:
        find = subprocess.Popen([*_FIND, item, "-w"], stdout=subprocess.PIPE, stderr=find_errors)
        assert find.stdout is not None
        strip = subprocess.Popen(
            ["tr", "-d", "\n"],
            stdin=find.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        find.stdout.close()
        assert strip.stdout is not None
        consumer = subprocess.Popen(
            argv, stdin=strip.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        strip.stdout.close()

        consumer_out, consumer_err = consumer.communicate()
        strip.wait()
        find.wait()
        find_errors.seek(0)
        find_err = find_errors.read().decode(errors="replace")

    # Reader first, but only when the reader has something to SAY. A pipeline fails in
    # both directions: a consumer that died because its input never arrived reports a
    # closed pipe and blames the wrong end — but so does the reader, when it is the
    # CONSUMER that exited first (a rejected `gh secret set`) and `tr` and `security`
    # died of EPIPE behind it, nonzero and silent. Reading the order off the exit codes
    # alone would then print `reading keychain item 'X' failed: ` with nothing after the
    # colon, and throw away gh's actual error. Whoever explained itself is believed.
    # [LAW:no-silent-failure]
    if find.returncode != 0 and find_err.strip():
        raise EffectError(f"reading keychain item {item!r} failed: {find_err.strip()}")
    if consumer.returncode != 0:
        raise EffectError(
            f"`{' '.join(argv)}` failed (exit {consumer.returncode}): {consumer_err.strip()}"
        )
    if find.returncode != 0:
        raise EffectError(
            f"reading keychain item {item!r} failed: `security` exited "
            f"{find.returncode} without explanation."
        )
    return consumer_out.strip()


def is_empty(item: str) -> bool:
    """Whether the item holds nothing, measured without reading it here.

    An empty item reads back exit 0 and would set an empty secret — a repo whose
    reviewer then fails to authenticate on every run, for a reason nothing in the
    install said. The byte count crosses the boundary; the bytes do not.
    [LAW:no-silent-failure]
    """
    return int(pipe_into(item, ["wc", "-c"])) == 0
