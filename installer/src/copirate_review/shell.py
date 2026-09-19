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
