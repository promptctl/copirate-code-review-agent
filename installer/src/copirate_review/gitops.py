"""The git side of the world: where we are, and landing the rendered workflow."""

from __future__ import annotations

from pathlib import Path

from .shell import EffectError, require, run, succeeds


def repo_root(cwd: Path) -> Path:
    require("git", "https://git-scm.com")
    try:
        return Path(run(["git", "rev-parse", "--show-toplevel"], cwd=cwd))
    except EffectError as exc:
        raise EffectError(f"not inside a git repository (cwd={cwd}).") from exc


def current_branch(root: Path) -> str:
    return run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root)


def commit(root: Path, paths: list[str], message: str) -> str:
    """Commit exactly these paths as their own commit, and return its short SHA.

    The pathspec form commits the working-tree version of the named paths and nothing
    else, whatever the index already holds — so a workflow converged in the middle of
    someone's half-staged work lands as its own commit and takes none of that work with
    it. The commit is separate on purpose: it is the installer's change, not the
    author's, and it must be readable as such in the PR. [LAW:decomposition]
    """
    run(["git", "commit", "-m", message, "--", *paths], cwd=root)
    return run(["git", "rev-parse", "--short", "HEAD"], cwd=root)


def push(root: Path, branch: str) -> None:
    """Push the current branch, establishing its upstream the first time.

    An unset upstream is a domain value — a branch that has not been pushed yet — not a
    failure, so it selects which push to run rather than aborting.
    [LAW:dataflow-not-control-flow]
    """
    has_upstream = succeeds(
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd=root
    )
    argv = ["git", "push"] if has_upstream else ["git", "push", "--set-upstream", "origin", branch]
    run(argv, cwd=root)
