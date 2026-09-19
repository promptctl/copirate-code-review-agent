"""The git side of the world: where we are, and landing the rendered workflow."""

from __future__ import annotations

from pathlib import Path

from .shell import EffectError, output_or_none, require, run, succeeds

#: The remote a branch pushes to when it has no upstream configured yet.
DEFAULT_REMOTE = "origin"

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


def push_remote(root: Path, branch: str | None) -> str:
    """The remote this branch pushes to: its upstream's, or `origin`.

    ONE answer to "which remote is this repository", used both to name the GitHub repo
    the secrets are written to and to push the commit. Letting `gh` resolve the repo on
    its own is a second map of that fact, and the two disagree exactly where it hurts:
    in a fork clone carrying both `origin` and `upstream`, gh answers with the PARENT,
    so the reviewer's credential is written to a repository the pull request will never
    run in — while the commit goes to the fork. Measured, not assumed: gh resolves
    `upstream` over `origin`. [LAW:one-source-of-truth]

    `--default` makes "no upstream configured yet" a value rather than a nonzero exit,
    so a brand-new branch takes the same path as every other one.
    """
    if branch is None:
        return DEFAULT_REMOTE
    key = f"branch.{branch}.remote"
    return run(["git", "config", "--get", "--default", DEFAULT_REMOTE, key], cwd=root)


def remote_url(root: Path, remote: str) -> str:
    """The URL of the remote we push to, which is what identifies the GitHub repo."""
    try:
        return run(["git", "remote", "get-url", remote], cwd=root)
    except EffectError as exc:
        raise EffectError(
            f"no git remote named {remote!r} in {root}. The installer provisions the "
            f"repository it pushes to, so it needs one: git remote add {remote} <url>"
        ) from exc


def upstream_ref(root: Path, branch: str | None, remote: str) -> str | None:
    """The remote-tracking ref for the branch `push` writes, or None when it has none.

    Asked as its own question because "the remote branch does not have this file" and
    "there is no remote branch" are different facts, and only the first is a reason to
    push. Reading them both off a missing blob makes every local branch look one push
    behind — so a developer who cut a branch from a converged default branch and stacked
    private commits on it would have the whole branch published by a tool documented as
    safe to run before every review. [LAW:types-are-the-program]

    The ref is DERIVED from the same two facts `push` is given, because it has to name
    the branch `push` would create. `@{u}` does not: it is built from `branch.<b>.merge`,
    the branch we PULL from, and the two part company the moment anyone runs
    `git checkout -b trunk origin/main` — a completely ordinary way to start work.
    There `@{u}` is `origin/main`, which exists, so this branch reads as published; the
    file is then compared against a DIFFERENT branch's copy, and the push that follows
    creates `origin/trunk` out of nothing. Both halves of the guarantee above, defeated
    by the same wrong ref. `@{push}` is no better — it answers for a bare `git push`
    under `push.default`, a command this module never runs. [LAW:one-source-of-truth]
    """
    if branch is None:
        return None
    # Full `refs/remotes/...` rather than `<remote>/<branch>`: the short form is
    # resolved against every namespace git knows, so a TAG sharing the branch's name
    # would answer this question with a ref no push will ever move.
    ref = f"refs/remotes/{remote}/{branch}"
    if not succeeds(["git", "rev-parse", "--verify", "--quiet", ref], cwd=root):
        return None
    return ref


def blob_at(root: Path, ref: str, path: str) -> str | None:
    """This path's content at a revision, or None where that revision does not have it.

    None is a state, not a failure, and it arrives three legitimate ways: the workflow
    is new and absent from HEAD, the branch has never been pushed so `@{u}` names
    nothing, or the repository has no commits at all. All three mean "not there yet" and
    must drive a write rather than an error. [LAW:types-are-the-program]
    """
    return output_or_none(["git", "cat-file", "blob", f"{ref}:{path}"], cwd=root)


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


def push(root: Path, branch: str, remote: str) -> None:
    """Push this branch to the named remote, establishing its upstream.

    One command, not two. The branch this pushes and the remote it pushes to are both
    named explicitly, so the push cannot land somewhere other than the repository whose
    secrets this run just provisioned — a bare `git push` re-derives both from config
    and, on a branch tracking a fork's parent, sends the commit to the parent.

    `--set-upstream` on a branch that already has one re-sets it to the value it already
    holds, so the "first push" and "every later push" cases are the same call rather
    than a branch on a condition. [LAW:no-mode-explosion]
    """
    try:
        run(["git", "push", "--set-upstream", remote, branch], cwd=root)
    except EffectError as exc:
        # Nothing here fetches, deliberately — a network round-trip on every run, to
        # refresh a ref that is almost always current, buys a race it still cannot win.
        # The cost of not fetching is paid HERE instead, as an explanation: a stale
        # remote-tracking ref makes this run see work to push that is really work to
        # pull, and git's own rejection does not mention that this tool never looked.
        # A loud failure nobody can act on is only half of [LAW:no-silent-failure].
        raise EffectError(
            f"could not push {branch} to {remote} — git said: {exc}\n"
            f"  If that is a rejected non-fast-forward: this installer never fetches, so "
            f"it read {remote}/{branch} from whatever your last fetch recorded. Someone "
            f"pushing since then leaves that copy behind, and the run reports work to "
            f"push that is really work to pull. Run `git pull --rebase` and re-run.\n"
            f"  The workflow is already committed on {branch} either way; only the push "
            f"is outstanding."
        ) from exc
