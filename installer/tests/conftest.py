"""Real git repositories for the tests that are about what git does.

Every fixture here builds an actual repository rather than a mock, because each test
using one is asserting git's behaviour — and a mock asserting what we BELIEVED git does
is exactly what let a fresh install fail on its own primary path.
[LAW:behavior-not-structure]
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _init(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    git(root, "commit", "-q", "--allow-empty", "-m", "base")
    return root


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository with one commit and no remote."""
    return _init(tmp_path)


@pytest.fixture
def pushed_repo(tmp_path: Path) -> Path:
    """A repository whose `main` tracks a real remote, so `@{u}` resolves.

    A bare repository stands in for GitHub. It is the only way to test "has this been
    pushed?" honestly: the question is answered from the remote-tracking ref git itself
    maintains, and nothing short of a real push moves that ref.
    """
    remote = tmp_path / "remote.git"
    subprocess.run(
        ["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True, capture_output=True
    )
    work = _init(tmp_path / "work")
    git(work, "remote", "add", "origin", str(remote))
    git(work, "push", "-q", "--set-upstream", "origin", "main")
    return work
