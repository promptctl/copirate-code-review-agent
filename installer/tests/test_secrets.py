"""What each declared secret needs, decided before anything is written.

The point of deciding here rather than midway through `apply` is that `--dry-run` can
only be trusted if it reaches the verdict the real run will act on. So these assert the
verdict, and one asserts that the dry run prints it.
"""

from __future__ import annotations

import pytest

from copirate_review import ghops, install, keychain
from copirate_review.config import Config
from copirate_review.ghops import Repo
from copirate_review.install import (
    KeepSecret,
    MissingSecret,
    Plan,
    SyncSecret,
    describe,
    landing_for,
    plan_secret,
)


@pytest.fixture
def world(monkeypatch):
    """Stand in for the keychain and the repo's two secret stores."""

    def configure(*, on_this_machine: bool, missing: tuple[str, ...] = ()) -> None:
        monkeypatch.setattr(keychain, "has_item", lambda item: on_this_machine)
        monkeypatch.setattr(ghops, "stores_missing", lambda repo, name: missing)

    return configure


def test_a_credential_on_this_machine_is_resynced_so_a_rotation_propagates(world):
    world(on_this_machine=True)
    assert plan_secret("o/r", "TOKEN", "TOKEN_ITEM") == SyncSecret("TOKEN", "TOKEN_ITEM")


def test_no_local_copy_but_both_stores_hold_it_is_left_exactly_as_it_is(world):
    """The desired state observably holds; this machine simply cannot refresh it."""
    world(on_this_machine=False, missing=())
    assert plan_secret("o/r", "TOKEN", "TOKEN_ITEM") == KeepSecret("TOKEN", "TOKEN_ITEM")


def test_a_half_provisioned_repo_fails_and_names_the_store_that_is_short(world):
    """Dependabot PRs would review unauthenticated, and nothing here can repair it."""
    world(on_this_machine=False, missing=("dependabot",))
    verdict = plan_secret("o/r", "TOKEN", "TOKEN_ITEM")
    assert isinstance(verdict, MissingSecret)
    assert "dependabot" in verdict.reason
    assert "unauthenticated" in verdict.reason


def test_a_credential_nowhere_at_all_fails_rather_than_promising_a_clean_review(world):
    world(on_this_machine=False, missing=tuple(ghops.SECRET_STORES))
    verdict = plan_secret("o/r", "TOKEN", "TOKEN_ITEM")
    assert isinstance(verdict, MissingSecret)
    assert "cannot authenticate" in verdict.reason


def test_the_dry_run_reports_the_verdict_the_real_run_will_act_on(capsys):
    """It used to print `sync` and exit 0 where the run exited 1. That predicts nothing."""
    plan = Plan(
        root=install.Path("/tmp"),
        repo=Repo(name_with_owner="o/r", default_branch="main"),
        branch="feature",
        remote="origin",
        upstream="origin/feature",
        landing=landing_for("feature", "main"),
        config=Config(action_ref="o/r@v1", commit_message="m", secrets={}, workflows=()),
        action_ref="o/r@v1",
        layers=(),
        changes=(),
        secrets=(
            SyncSecret("HAVE_IT", "HAVE_ITEM"),
            MissingSecret("LOST_IT", "LOST_ITEM", "the reviewer cannot authenticate."),
        ),
    )
    describe(plan)
    reported = capsys.readouterr().out
    assert "sync      HAVE_IT" in reported
    assert "MISSING   LOST_IT" in reported
