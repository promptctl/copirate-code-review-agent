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


def current_branch(root: Path) -> str | None:
    """The branch HEAD is on, or None when HEAD is detached.

    Detachment is a real state of a repository — mid-rebase, mid-bisect, after a
    `git checkout <sha>` — so it is a VALUE here, not an error and not a branch named
    "HEAD". `git rev-parse --abbrev-ref` returns the literal string "HEAD" in that
    state, which compares unequal to every real branch name and so reads downstream as
    an ordinary feature branch; `symbolic-ref` fails instead, which is the honest
    answer. [LAW:types-are-the-program]
    """
    if not succeeds(["git", "symbolic-ref", "--quiet", "HEAD"], cwd=root):
        return None
    return run(["git", "symbolic-ref", "--short", "HEAD"], cwd=root)


def commit(root: Path, paths: list[str], message: str) -> str:
    """Commit exactly these paths as their own commit, and return its short SHA.

    Staged first because a pathspec names files git already knows: on a fresh install
    the workflow is brand new, and `git commit -- <untracked>` fails outright with
    "did not match any file(s) known to git" — after the secrets have already been
    pushed. The pathspec still does its job after the add: it commits these paths and
    nothing else, leaving anything else already staged staged.

    The commit is separate on purpose — it is the installer's change, not the author's,
    and it must be readable as such in the PR. [LAW:decomposition]
    """
    run(["git", "add", "--", *paths], cwd=root)
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
