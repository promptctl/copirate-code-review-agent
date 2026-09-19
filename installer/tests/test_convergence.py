"""How far a rendered workflow has reached, and what that makes the run do next.

GitHub runs what is PUSHED. So "converged" is a question about three places, and these
tests hold the model to that — each one describes a repository the installer could
genuinely be run in, and asserts what still has to happen there.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from copirate_review.config import Config
from copirate_review.ghops import Repo
from copirate_review.gitops import (
    blob_at,
    current_branch,
    push,
    push_remote,
    remote_url,
    upstream_ref,
)
from copirate_review.install import Plan, Unpublished, landing_for, snapshot
from copirate_review.render import Rendered
from copirate_review.shell import EffectError

from .conftest import git

WORKFLOW = ".github/workflows/code-review.yml"
TEXT = "name: Review\non: pull_request\n"


def rendered(text: str = TEXT) -> Rendered:
    return Rendered(path=WORKFLOW, text=text, base_file="pr-review.yml")


def write(root: Path, text: str = TEXT) -> None:
    (root / WORKFLOW).parent.mkdir(parents=True, exist_ok=True)
    (root / WORKFLOW).write_text(text)


def snap(root: Path, text: str = TEXT):
    """Take the snapshot the way a real run does, upstream and all."""
    branch = current_branch(root)
    return snapshot(root, rendered(text), upstream_ref(root, branch, push_remote(root, branch)))


def plan_for(root: Path, *changes) -> Plan:
    branch = current_branch(root) or "feature"
    return Plan(
        root=root,
        repo=Repo(name_with_owner="o/r", default_branch="main"),
        branch=branch,
        remote="origin",
        upstream=upstream_ref(root, branch, push_remote(root, branch)),
        landing=landing_for(branch, "not-the-default-branch"),
        config=Config(action_ref="o/r@v1", commit_message="m", secrets={}, workflows=()),
        action_ref="o/r@v1",
        layers=(),
        changes=tuple(changes),
        secrets=(),
    )


# --- reading a revision -----------------------------------------------------------


def test_a_path_the_revision_does_not_carry_reads_as_absent_not_as_a_failure(repo):
    write(repo)
    assert blob_at(repo, "HEAD", WORKFLOW) is None


def test_a_committed_path_reads_back_byte_for_byte_including_its_last_newline(repo):
    write(repo)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "add")
    assert blob_at(repo, "HEAD", WORKFLOW) == TEXT


def test_a_branch_that_was_never_pushed_has_no_upstream_ref_to_read(repo):
    write(repo)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "add")
    branch = current_branch(repo)
    assert upstream_ref(repo, branch, push_remote(repo, branch)) is None


# --- the three snapshots ----------------------------------------------------------


def test_a_workflow_written_but_never_committed_is_not_reported_as_converged(repo):
    """The defect this model exists to prevent.

    A run held on the default branch, or one whose secret sync failed after the write,
    leaves the file on disk and nothing in git. Comparing against the working tree alone
    then calls that converged — forever, because every later run finds the same file.
    """
    write(repo)
    change = snap(repo)

    assert change.needs_write is False, "the file on disk already matches"
    assert change.needs_commit is True, "but HEAD does not have it"
    assert change.verb == "create"
    assert plan_for(repo, change).commit_paths == [WORKFLOW]


def test_a_committed_workflow_that_was_never_pushed_still_has_somewhere_to_go(pushed_repo):
    """The failed-push path: nothing left to write or commit, and still not deployed."""
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    change = snap(pushed_repo)

    assert change.needs_write is False
    assert change.needs_commit is False
    assert change.needs_push is True
    assert change.verb == "push"
    plan = plan_for(pushed_repo, change)
    assert plan.commit_paths == [], "there is nothing to commit"
    assert plan.unlanded_paths == [WORKFLOW], "and still something to push"


def test_a_workflow_committed_and_pushed_is_finally_converged(pushed_repo):
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    git(pushed_repo, "push", "-q")
    change = snap(pushed_repo)

    assert (change.needs_write, change.needs_commit, change.needs_push) == (False, False, False)
    assert change.verb == "unchanged"
    assert plan_for(pushed_repo, change).unlanded_paths == []


def test_a_base_change_reaches_every_place_the_old_text_had(pushed_repo):
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    git(pushed_repo, "push", "-q")
    change = snap(pushed_repo, "name: Review v2\n")

    assert (change.needs_write, change.needs_commit, change.needs_push) == (True, True, True)
    assert change.verb == "update"


def test_a_hand_edited_workflow_is_rewritten_without_inventing_a_commit(pushed_repo):
    """Only the file drifted, so only the file is repaired — git already agrees."""
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    git(pushed_repo, "push", "-q")
    write(pushed_repo, "name: someone edited this by hand\n")
    change = snap(pushed_repo)

    assert change.needs_write is True
    assert (change.needs_commit, change.needs_push) == (False, False)
    assert plan_for(pushed_repo, change).unlanded_paths == []


# --- a branch nobody has published ------------------------------------------------


def test_a_private_branch_is_never_published_just_because_it_has_no_upstream(pushed_repo):
    """The regression: an unpublished branch is not BEHIND the remote, it is absent.

    A developer cuts a branch from a default branch where the workflow is already
    converged and stacks private commits on it. Nothing needs writing, nothing needs
    committing — and reading "no upstream" as "the remote is missing this file" made the
    run push anyway, publishing every one of those commits. The installer converges a
    workflow; it does not decide that someone's branch should become public.
    """
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "converge on the default branch")
    git(pushed_repo, "push", "-q")

    git(pushed_repo, "checkout", "-q", "-b", "private-wip")
    (pushed_repo / "secret-plans.txt").write_text("not for the remote\n")
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "WIP")

    change = snap(pushed_repo)
    assert isinstance(change.remote, Unpublished)
    assert (change.needs_write, change.needs_commit, change.needs_push) == (False, False, False)
    assert change.verb == "unchanged"
    assert plan_for(pushed_repo, change).unlanded_paths == [], "nothing to land, nothing to push"


def test_a_branch_cut_from_the_remote_default_branch_is_still_not_published(pushed_repo):
    """The upstream ref must name the branch we would PUSH, not the one we pull from.

    `git checkout -b trunk origin/main` is the ordinary way to start work, and it sets
    `branch.trunk.merge` to `refs/heads/main` — so `@{u}` resolves to `origin/main`, a
    ref that very much exists. Reading published-ness off it got both halves wrong at
    once: the branch read as published, so `needs_push` compared the render against a
    DIFFERENT branch's copy of the file, and the push that followed created
    `origin/trunk` out of nothing — from a tool that promises never to publish a branch
    the remote does not already have. [LAW:one-source-of-truth]
    """
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "converge on the default branch")
    git(pushed_repo, "push", "-q")

    git(pushed_repo, "checkout", "-q", "-b", "trunk", "origin/main")
    assert current_branch(pushed_repo) == "trunk"
    assert push_remote(pushed_repo, "trunk") == "origin", "so `push` would write origin/trunk"

    change = snap(pushed_repo, "name: Changed on trunk alone\non: pull_request\n")
    assert isinstance(change.remote, Unpublished), "origin/trunk does not exist"
    assert change.needs_push is False, "this was answered from origin/main's copy of the file"
    assert plan_for(pushed_repo, change).upstream is None, "so _land has nothing to push"


def test_a_workflow_committed_onto_an_unpublished_branch_waits_for_its_own_push(pushed_repo):
    """There IS something to land, and it still is not ours to publish.

    The commit goes on the branch; the developer's first push carries it. What must not
    happen is the installer creating the remote branch on their behalf.
    """
    git(pushed_repo, "checkout", "-q", "-b", "private-wip")
    write(pushed_repo)
    change = snap(pushed_repo)

    assert isinstance(change.remote, Unpublished)
    assert change.needs_commit is True
    plan = plan_for(pushed_repo, change)
    assert plan.commit_paths == [WORKFLOW]
    assert plan.upstream is None, "and _land refuses to push on that"


def test_a_push_rejected_against_a_stale_ref_says_so_instead_of_only_relaying_git(
    pushed_repo, tmp_path
):
    """The one failure this tool can cause and not explain.

    Nothing here fetches, so `needs_push` is read off the copy the last fetch left
    behind. A teammate pushing in the meantime turns work-to-pull into what looks like
    work-to-push, and git's rejection never mentions that this tool did not look.
    [LAW:no-silent-failure]
    """
    other = tmp_path / "teammate"
    git(tmp_path, "clone", "-q", str(tmp_path / "remote.git"), str(other))
    git(other, "config", "user.email", "them@example.com")
    git(other, "config", "user.name", "Them")
    git(other, "commit", "-q", "--allow-empty", "-m", "landed while we were not looking")
    git(other, "push", "-q")

    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "converge")

    with pytest.raises(EffectError) as refusal:
        push(pushed_repo, "main", "origin")
    assert "git pull --rebase" in str(refusal.value)
    assert "already committed" in str(refusal.value), "so nobody re-runs the whole install"


# --- which remote we are talking about --------------------------------------------


def test_a_branch_with_no_upstream_pushes_to_origin(repo):
    assert push_remote(repo, "main") == "origin"


def test_a_branch_pushes_to_the_remote_it_actually_tracks(pushed_repo):
    git(pushed_repo, "remote", "add", "upstream", "https://github.com/someone/else.git")
    assert push_remote(pushed_repo, "main") == "origin", "tracking wins over remote order"

    git(pushed_repo, "config", "branch.main.remote", "upstream")
    assert push_remote(pushed_repo, "main") == "upstream"


def test_a_detached_head_still_names_a_remote_to_identify_the_repository(repo):
    assert push_remote(repo, None) == "origin"


def test_a_repository_with_no_remote_says_so_rather_than_failing_obscurely(repo):
    with pytest.raises(EffectError, match="no git remote named 'origin'"):
        remote_url(repo, "origin")


def test_the_plan_names_the_base_each_workflow_was_rendered_from(repo, capsys):
    """The operator's question on seeing an unexpected render is *which file did this*."""
    from copirate_review.config import Config
    from copirate_review.ghops import Repo
    from copirate_review.install import describe, landing_for

    describe(
        Plan(
            root=repo,
            repo=Repo(name_with_owner="o/r", default_branch="main"),
            branch="feature",
            remote="origin",
            upstream=None,
            landing=landing_for("feature", "main"),
            config=Config(action_ref="o/r@v1", commit_message="m", secrets={}, workflows=()),
            action_ref="o/r@v1",
            layers=(),
            changes=(snap(repo),),
            secrets=(),
        )
    )
    assert "pr-review.yml" in capsys.readouterr().out
