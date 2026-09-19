"""What each declared secret needs, decided before anything is written.

The point of deciding here rather than midway through `apply` is that `--dry-run` can
only be trusted if it reaches the verdict the real run will act on. So these assert the
verdict, and one asserts that the dry run prints it.
"""

from __future__ import annotations

import pytest

from copirate_review import ghops, install
from copirate_review.config import Config
from copirate_review.credentials import EnvCredential, KeychainCredential
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


ITEM = KeychainCredential(item="TOKEN_ITEM")


@pytest.fixture
def world(monkeypatch):
    """Stand in for a credential's source and for the repo's two secret stores."""

    def configure(
        *, on_this_machine: bool, holds: str = "a-real-token", missing: tuple[str, ...] = ()
    ) -> None:
        for source in (KeychainCredential, EnvCredential):
            monkeypatch.setattr(source, "present", lambda self: on_this_machine)
            # The VALUE is stood in for too, not just its existence: the plan now reads
            # it to decide, so a fixture that stubs only `present` leaves the real
            # `security` to answer the other half. Substituting the reader keeps the
            # pipeline that measures it the genuine one. [LAW:behavior-not-structure]
            monkeypatch.setattr(
                source, "stages", property(lambda self: [["printf", "%s", holds]])
            )
        monkeypatch.setattr(ghops, "stores_missing", lambda repo, name: missing)

    return configure


def test_a_credential_on_this_machine_is_resynced_so_a_rotation_propagates(world):
    world(on_this_machine=True)
    assert plan_secret("o/r", "TOKEN", ITEM) == SyncSecret("TOKEN", ITEM)


def test_no_local_copy_but_both_stores_hold_it_is_left_exactly_as_it_is(world):
    """The desired state observably holds; this machine simply cannot refresh it."""
    world(on_this_machine=False, missing=())
    assert plan_secret("o/r", "TOKEN", ITEM) == KeepSecret("TOKEN", ITEM)


def test_a_half_provisioned_repo_fails_and_names_the_store_that_is_short(world):
    """Dependabot PRs would review unauthenticated, and nothing here can repair it."""
    world(on_this_machine=False, missing=("dependabot",))
    verdict = plan_secret("o/r", "TOKEN", ITEM)
    assert isinstance(verdict, MissingSecret)
    assert "dependabot" in verdict.reason
    assert "unauthenticated" in verdict.reason


def test_a_credential_nowhere_at_all_fails_rather_than_promising_a_clean_review(world):
    world(on_this_machine=False, missing=tuple(ghops.SECRET_STORES))
    verdict = plan_secret("o/r", "TOKEN", ITEM)
    assert isinstance(verdict, MissingSecret)
    assert "cannot authenticate" in verdict.reason


def test_a_source_that_is_there_but_empty_is_not_a_credential(world):
    """`present()` is not the question; holding a VALUE is.

    An exported-but-empty variable, or an item stored empty, passed `present()` and was
    refused at the write — so the dry run printed `sync` and exited 0 while the run it
    claimed to predict exited 1. Nothing about that is knowable only over the network.
    """
    world(on_this_machine=True, holds="", missing=tuple(ghops.SECRET_STORES))
    verdict = plan_secret("o/r", "TOKEN", ITEM)
    assert isinstance(verdict, MissingSecret)
    assert "holds an empty value" in verdict.reason, "and not 'is not available'"


def test_an_empty_local_source_does_not_fail_a_repo_whose_stores_are_already_good(world):
    """The run used to abort here. There is nothing to repair and nothing to break."""
    world(on_this_machine=True, holds="", missing=())
    assert plan_secret("o/r", "TOKEN", ITEM) == KeepSecret("TOKEN", ITEM)


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
            SyncSecret("HAVE_IT", KeychainCredential(item="HAVE_ITEM")),
            MissingSecret(
                "LOST_IT", EnvCredential(var="LOST_VAR"), "the reviewer cannot authenticate."
            ),
        ),
    )
    describe(plan)
    reported = capsys.readouterr().out
    assert "sync      HAVE_IT" in reported
    assert "MISSING   LOST_IT" in reported
    # Each names the source it actually reads, so the operator knows where to look.
    assert "keychain item HAVE_ITEM" in reported
    assert "environment variable $LOST_VAR" in reported


def test_a_verdict_is_reached_the_same_way_whatever_source_the_secret_names(world):
    """The three-way store logic is one rule; a source only answers present or not."""
    world(on_this_machine=False, missing=tuple(ghops.SECRET_STORES))
    from_env = plan_secret("o/r", "TOKEN", EnvCredential(var="TOKEN_VAR"))
    assert isinstance(from_env, MissingSecret)
    assert "environment variable $TOKEN_VAR" in from_env.reason
