"""Read credentials out of the macOS keychain without the value entering this process.

Every credential flows keychain → consumer over an OS pipe. It is never bound to a
Python name, never passed in argv, never logged, and never returned from any function
here. This module orchestrates the pipe; it cannot observe what travels through it.
[LAW:effects-at-boundaries]
"""

from __future__ import annotations

import subprocess

from .shell import EffectError, succeeds

_FIND = ["security", "find-generic-password", "-s"]


def has_item(item: str) -> bool:
    """Whether this machine holds the named generic-password item."""
    return succeeds([*_FIND, item])


def is_empty(item: str) -> bool:
    """Whether the item holds nothing, measured without reading it here.

    An empty item reads back exit 0 and would set an empty secret — a repo whose
    reviewer then fails to authenticate on every run, for a reason nothing in the
    install said. The byte count crosses the boundary; the bytes do not.
    [LAW:no-silent-failure]
    """
    find = subprocess.Popen([*_FIND, item, "-w"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert find.stdout is not None
    counted = subprocess.run(["wc", "-c"], stdin=find.stdout, capture_output=True, text=True)
    find.stdout.close()
    detail = find.stderr.read().decode().strip() if find.stderr else ""
    if find.wait() != 0:
        raise EffectError(f"keychain item {item!r} could not be read: {detail}")
    return int(counted.stdout.strip()) == 0


def pipe_into(item: str, argv: list[str]) -> None:
    """Stream the item's value, newline-stripped, into `argv`'s stdin.

    The `tr` stage is a separate process for the same reason the whole chain is: doing
    the strip in Python would mean reading the credential into this process's memory to
    remove one byte from it.
    """
    find = subprocess.Popen([*_FIND, item, "-w"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert find.stdout is not None
    strip = subprocess.Popen(
        ["tr", "-d", "\n"], stdin=find.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    find.stdout.close()
    assert strip.stdout is not None
    consumer = subprocess.Popen(
        argv, stdin=strip.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    strip.stdout.close()

    _, consumer_err = consumer.communicate()
    strip.wait()
    find_err = find.stderr.read().decode() if find.stderr else ""
    find.wait()

    # Checked downstream-last so the most specific cause wins: a consumer that rejected
    # the value says more than "the pipe closed early", which is what the reader reports
    # when the consumer dies first.
    if find.returncode != 0:
        raise EffectError(f"reading keychain item {item!r} failed: {find_err.strip()}")
    if consumer.returncode != 0:
        raise EffectError(
            f"`{' '.join(argv)}` failed (exit {consumer.returncode}): {consumer_err.strip()}"
        )
