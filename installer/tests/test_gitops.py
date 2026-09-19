"""Landing a commit: where it may go, and that it actually goes there.

These exercise a real repository rather than a mock, because every one of them is about
what `git` does — and a mock asserting what we believed git does is what let a fresh
install fail on its own primary path. [LAW:behavior-not-structure]
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from copirate_review.gitops import commit, current_branch
from copirate_review.install import Hold, Land, landing_for

WORKFLOW = ".github/workflows/code-review.yml"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    git("commit", "-q", "--allow-empty", "-m", "base")
    return tmp_path


def tracked_in_head(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "show", "--name-only", "--format=", "HEAD"],
        cwd=repo, capture_output=True, text=True, check=True,
    )
    return out.stdout.split()


# --- committing -------------------------------------------------------------------


def test_a_workflow_that_did_not_exist_before_is_committed(repo):
    """The fresh-install path: `git commit -- <pathspec>` alone cannot see a new file."""
    (repo / ".github/workflows").mkdir(parents=True)
    (repo / WORKFLOW).write_text("name: Review\n")
    commit(repo, [WORKFLOW], "Converge the workflow")
    assert tracked_in_head(repo) == [WORKFLOW]


def test_the_commit_takes_nothing_else_the_author_had_staged(repo):
    (repo / ".github/workflows").mkdir(parents=True)
    (repo / WORKFLOW).write_text("name: Review\n")
    (repo / "theirs.txt").write_text("half-finished work\n")
    subprocess.run(["git", "add", "theirs.txt"], cwd=repo, check=True, capture_output=True)

    commit(repo, [WORKFLOW], "Converge the workflow")

    assert tracked_in_head(repo) == [WORKFLOW]
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only"], cwd=repo, capture_output=True, text=True
    )
    assert staged.stdout.split() == ["theirs.txt"]


def test_an_unchanged_workflow_still_commits_when_asked_again(repo):
    """Re-running is safe: the caller only asks for paths that differ."""
    (repo / ".github/workflows").mkdir(parents=True)
    (repo / WORKFLOW).write_text("name: Review\n")
    commit(repo, [WORKFLOW], "first")
    (repo / WORKFLOW).write_text("name: Review v2\n")
    commit(repo, [WORKFLOW], "second")
    assert tracked_in_head(repo) == [WORKFLOW]


# --- where we are -----------------------------------------------------------------


def test_a_branch_reports_its_own_name(repo):
    assert current_branch(repo) == "main"


def test_a_detached_head_is_no_branch_rather_than_a_branch_called_head(repo):
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    subprocess.run(["git", "checkout", "-q", sha], cwd=repo, check=True, capture_output=True)
    assert current_branch(repo) is None


# --- whether we may land ----------------------------------------------------------


def test_a_feature_branch_is_where_the_commit_goes():
    assert landing_for("my-feature", "main") == Land("my-feature")


@pytest.mark.parametrize(
    "branch, default_branch, expected",
    [
        (None, "main", "detached"),
        ("main", "main", "default branch"),
        ("main", None, "no commits on GitHub yet"),
    ],
    ids=["detached-head", "on-the-default-branch", "repository-has-no-commits"],
)
def test_a_commit_is_held_where_it_would_be_wrong_or_unreachable(branch, default_branch, expected):
    landing = landing_for(branch, default_branch)
    assert isinstance(landing, Hold)
    assert expected in landing.reason


def test_the_report_names_the_branch_we_are_actually_on_even_when_the_commit_is_held(capsys):
    """The header reads the observed branch, never reconstructs it from the decision."""
    from copirate_review.install import Plan, describe
    from copirate_review.ghops import Repo
    from copirate_review.config import Config

    plan = Plan(
        root=Path("/tmp"),
        repo=Repo(name_with_owner="o/r", default_branch="main"),
        branch="main",
        landing=landing_for("main", "main"),
        config=Config(action_ref="o/r@v1", commit_message="m", secrets={}, workflows=()),
        action_ref="o/r@v1",
        layers=(),
        changes=(),
    )
    describe(plan)
    assert "o/r on main" in capsys.readouterr().out
