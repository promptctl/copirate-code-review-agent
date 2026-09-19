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
from copirate_review.gitops import UPSTREAM, blob_at, push_remote, remote_url
from copirate_review.install import Plan, landing_for, snapshot
from copirate_review.render import Rendered
from copirate_review.shell import EffectError

from .conftest import git

WORKFLOW = ".github/workflows/code-review.yml"
TEXT = "name: Review\non: pull_request\n"


def rendered(text: str = TEXT) -> Rendered:
    return Rendered(path=WORKFLOW, text=text, template_file="pr-review.yml.j2")


def write(root: Path, text: str = TEXT) -> None:
    (root / WORKFLOW).parent.mkdir(parents=True, exist_ok=True)
    (root / WORKFLOW).write_text(text)


def plan_for(root: Path, *changes) -> Plan:
    return Plan(
        root=root,
        repo=Repo(name_with_owner="o/r", default_branch="main"),
        branch="feature",
        remote="origin",
        landing=landing_for("feature", "main"),
        config=Config(action_ref="o/r@v1", commit_message="m", secrets={}, workflows=()),
        action_ref="o/r@v1",
        layers=(),
        changes=tuple(changes),
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


def test_a_branch_that_was_never_pushed_has_no_upstream_content(repo):
    write(repo)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "add")
    assert blob_at(repo, UPSTREAM, WORKFLOW) is None


# --- the three snapshots ----------------------------------------------------------


def test_a_workflow_written_but_never_committed_is_not_reported_as_converged(repo):
    """The defect this model exists to prevent.

    A run held on the default branch, or one whose secret sync failed after the write,
    leaves the file on disk and nothing in git. Comparing against the working tree alone
    then calls that converged — forever, because every later run finds the same file.
    """
    write(repo)
    change = snapshot(repo, rendered())

    assert change.needs_write is False, "the file on disk already matches"
    assert change.needs_commit is True, "but HEAD does not have it"
    assert change.verb == "create"
    assert plan_for(repo, change).commit_paths == [WORKFLOW]


def test_a_committed_workflow_that_was_never_pushed_still_has_somewhere_to_go(pushed_repo):
    """The failed-push path: nothing left to write or commit, and still not deployed."""
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    change = snapshot(pushed_repo, rendered())

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
    change = snapshot(pushed_repo, rendered())

    assert (change.needs_write, change.needs_commit, change.needs_push) == (False, False, False)
    assert change.verb == "unchanged"
    assert plan_for(pushed_repo, change).unlanded_paths == []


def test_a_template_change_reaches_every_place_the_old_text_had(pushed_repo):
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    git(pushed_repo, "push", "-q")
    change = snapshot(pushed_repo, rendered("name: Review v2\n"))

    assert (change.needs_write, change.needs_commit, change.needs_push) == (True, True, True)
    assert change.verb == "update"


def test_a_hand_edited_workflow_is_rewritten_without_inventing_a_commit(pushed_repo):
    """Only the file drifted, so only the file is repaired — git already agrees."""
    write(pushed_repo)
    git(pushed_repo, "add", "-A")
    git(pushed_repo, "commit", "-qm", "add")
    git(pushed_repo, "push", "-q")
    write(pushed_repo, "name: someone edited this by hand\n")
    change = snapshot(pushed_repo, rendered())

    assert change.needs_write is True
    assert (change.needs_commit, change.needs_push) == (False, False)
    assert plan_for(pushed_repo, change).unlanded_paths == []


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
