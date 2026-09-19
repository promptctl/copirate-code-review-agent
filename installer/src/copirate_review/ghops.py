"""The GitHub side of the world: what repo this is, and writing its secrets."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from . import keychain
from .shell import EffectError, require, run, succeeds

#: GitHub feeds Dependabot-triggered runs from a store SEPARATE from the Actions one, so
#: `${{ secrets.X }}` in the same workflow resolves from different places depending on
#: who opened the PR. A secret written only to the Actions store leaves every Dependabot
#: review silently unauthenticated. Both stores, every time — and every question asked
#: about a secret's presence is asked of both, or it answers for half the runs.
#: [LAW:no-silent-failure]
SECRET_STORES = ("actions", "dependabot")


@dataclass(frozen=True)
class Repo:
    """The GitHub repository this run targets, as GitHub itself reports it.

    `default_branch` is None for a repository with no commits: GitHub has no default
    branch to name yet. That is a real state — a repo created minutes ago — and it is a
    value rather than an empty string, which would compare unequal to every branch and
    so read as "you are not on the default branch". [LAW:types-are-the-program]
    """

    name_with_owner: str
    default_branch: str | None


def require_cli() -> None:
    require("gh", "https://cli.github.com")


def require_auth() -> None:
    if not succeeds(["gh", "auth", "status"]):
        raise EffectError("gh is not authenticated. Run: gh auth login")


def resolve(cwd: Path) -> Repo:
    """Resolve the repo from this directory's remote, confirming gh can reach it."""
    try:
        payload = run(
            ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"], cwd=cwd
        )
    except EffectError as exc:
        raise EffectError(
            f"gh could not resolve a GitHub repo for {cwd} (no GitHub remote, or no access): {exc}"
        ) from exc
    data = json.loads(payload)
    ref = data["defaultBranchRef"]
    return Repo(
        name_with_owner=data["nameWithOwner"],
        default_branch=ref["name"] if ref else None,
    )


def stores_missing(repo: str, name: str) -> tuple[str, ...]:
    """Which of the secret stores do NOT hold this secret, asked of each one.

    A failed listing must NOT read as "absent": that routes a gh outage into the fatal
    missing-credential verdict, with a message naming the wrong cause. `run` raises on
    failure, so only a successful listing can answer this. [LAW:no-silent-failure]
    """
    absent = []
    for store in SECRET_STORES:
        names = run(
            ["gh", "secret", "list", "-R", repo, "--app", store, "--json", "name", "-q", ".[].name"]
        )
        if name not in names.splitlines():
            absent.append(store)
    return tuple(absent)


def sync_secret(repo: str, name: str, item: str) -> None:
    """Write one keychain item into both of the repo's secret stores.

    `-R` pins the same repo the caller resolved. Without it gh re-resolves from the
    remotes itself, which in a fork (origin + upstream) is a different repo — secrets
    would land on upstream, or the call would abort as ambiguous.
    """
    if keychain.is_empty(item):
        raise EffectError(
            f"keychain item {item!r} has an empty value — refusing to set an empty {name}."
        )
    # The two stores are two independent network writes of the same value, so they cost
    # one write's latency rather than two. The installer runs on every review; the
    # seconds are the budget it has to stay inside.
    with ThreadPoolExecutor(max_workers=len(SECRET_STORES)) as pool:
        writes = [
            pool.submit(
                keychain.pipe_into,
                item,
                ["gh", "secret", "set", name, "-R", repo, "--app", store],
            )
            for store in SECRET_STORES
        ]
        for write in writes:
            write.result()
