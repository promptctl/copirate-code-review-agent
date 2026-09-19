"""Run external commands, and make every failure loud and located.

The one primitive the installer's world-facing modules share. Nothing here suppresses
stderr, defaults past a nonzero exit, or falls back to a second command when the first
fails — a swallowed failure travels downstream as wrongness with no source, and an
installer that reports success having provisioned nothing is the exact lie this tool
exists to prevent. [LAW:no-silent-failure]
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class EffectError(Exception):
    """An external command failed, or a required one is not installed."""


def require(program: str, hint: str) -> None:
    if shutil.which(program) is None:
        raise EffectError(f"{program} is not installed ({hint}).")


def run(argv: list[str], *, cwd: Path | None = None) -> str:
    """Run a command to completion and return its stdout, or raise naming the cause."""
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise EffectError(f"`{' '.join(argv)}` failed (exit {result.returncode}): {detail}")
    return result.stdout.strip()


def succeeds(argv: list[str], *, cwd: Path | None = None) -> bool:
    """Whether a command exits zero, for the questions whose answer IS the exit status.

    Distinct from `run` on purpose: here a nonzero exit is a domain value ("no upstream
    is configured"), not a failure to report. Reserved for commands that ask a question;
    anything that performs an action goes through `run`, where failure is loud.
    """
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True).returncode == 0


def output_or_none(argv: list[str], *, cwd: Path | None = None) -> str | None:
    """Stdout verbatim when the command succeeds, `None` when it does not.

    `succeeds`' sibling, for the questions whose answer is CONTENT-or-absence rather
    than yes-or-no: `git cat-file blob HEAD:<path>` against a path HEAD does not carry.
    Absence is the answer, not a failure — the workflow is simply new here.

    Stdout is returned UNTRIMMED, which is the whole reason this is not `run`. `run`
    strips because its callers read a value — a branch name, a SHA — whose surrounding
    whitespace is noise. A file's bytes are not a value: its trailing newline is data,
    and stripping it turns a byte-for-byte comparison into one that silently ignores the
    end of every file it compares. [LAW:one-type-per-behavior]

    Decoded HERE rather than by `text=True`, which would also translate line endings.
    `git cat-file blob` emits the blob's own bytes, and a workflow committed with CRLF
    then arrives as LF — equal to a render that is nothing like it, so the run reports
    a workflow converged that it has never actually written. Verified: a CRLF blob read
    back identical to an LF render. Newline translation is precisely the "silently
    ignores" this function exists to refuse, applied to every line instead of the last.
    """
    result = subprocess.run(argv, cwd=cwd, capture_output=True)
    if result.returncode != 0:
        return None
    return decoded(result.stdout, " ".join(argv))


def decoded(raw: bytes, source: str) -> str:
    """The text of some bytes, or a refusal naming where they came from.

    A workflow is text. Bytes that are not is a state worth reporting as the failure it
    is, with the source named — not as a `UnicodeDecodeError` traceback carrying an
    exit code the CLI's contract does not describe. [LAW:no-silent-failure]
    """
    try:
        return raw.decode()
    except UnicodeDecodeError as exc:
        raise EffectError(
            f"{source} returned bytes that are not UTF-8 ({exc}). A workflow is text; "
            f"this one is not, so there is nothing here to compare it against."
        ) from exc
