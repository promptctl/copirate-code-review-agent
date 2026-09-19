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


def pipe_into(item: str, argv: list[str]) -> str:
    """Stream the item's value, newline-stripped, into `argv`'s stdin; return its stdout.

    ONE pipeline, which every reader of a keychain item goes through. `security … -w`
    appends a newline to whatever it prints, and that newline is the whole reason the
    `tr` stage exists — a second pipeline built beside this one is a second place that
    has to know, and the one that forgets reads an empty item as one byte of content.
    [LAW:one-source-of-truth]

    `tr` is a separate process for the same reason the whole chain is: stripping the
    newline in Python would mean reading the credential into this process's memory.
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

    consumer_out, consumer_err = consumer.communicate()
    strip.wait()
    find_err = find.stderr.read().decode() if find.stderr else ""
    find.wait()

    # Checked reader-first so the most specific cause wins: a consumer that died because
    # its input never arrived reports a closed pipe, which says nothing about the locked
    # keychain that actually caused it.
    if find.returncode != 0:
        raise EffectError(f"reading keychain item {item!r} failed: {find_err.strip()}")
    if consumer.returncode != 0:
        raise EffectError(
            f"`{' '.join(argv)}` failed (exit {consumer.returncode}): {consumer_err.strip()}"
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
