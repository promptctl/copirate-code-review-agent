"""Converge a repository onto its configuration: render, compare, act on the difference.

The run is described before any of it is performed. `build_plan` reads the world and produces
a `Plan` — every write the run will make, and no write made yet; `apply` performs
exactly that plan. `--dry-run` is the same plan with `apply` never called, which is why
it can be trusted to predict a real run. [LAW:effects-at-boundaries]
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from . import ghops, gitops, keychain
from .config import Config, load
from .ghops import Repo
from .render import Rendered, render, resolve_action_ref
from .shell import EffectError


@dataclass(frozen=True)
class WorkflowChange:
    """One workflow's desired text beside what is deployed, if anything is."""

    rendered: Rendered
    deployed: str | None

    @property
    def changed(self) -> bool:
        return self.deployed != self.rendered.text

    @property
    def verb(self) -> str:
        return "unchanged" if not self.changed else ("create" if self.deployed is None else "update")


@dataclass(frozen=True)
class Plan:
    """Everything a run will do, computed before it does any of it."""

    root: Path
    repo: Repo
    branch: str
    config: Config
    action_ref: str
    layers: tuple[Path, ...]
    changes: tuple[WorkflowChange, ...]

    @property
    def changed_paths(self) -> list[str]:
        return [c.rendered.path for c in self.changes if c.changed]

    @property
    def on_default_branch(self) -> bool:
        return self.branch == self.repo.default_branch


def say(message: str) -> None:
    print(message)


def warn(message: str) -> None:
    print(message, file=sys.stderr)


def preflight(cwd: Path) -> tuple[Path, Repo, str]:
    """Establish the preconditions both targets need, each failing with its own cause.

    The keychain is deliberately absent: it is an input to exactly one effect, and is
    demanded only at the moment that effect must write. A run that changes nothing needs
    no credential and must not stop for one.

    `gh auth status` is resolved before the repo lookup even though the lookup subsumes
    it — an unauthenticated gh makes every request fail, and "no GitHub remote, or no
    access" would send the operator hunting a remote that is fine.
    [LAW:no-silent-failure]
    """
    root = gitops.repo_root(cwd)
    ghops.require_cli()
    with ThreadPoolExecutor(max_workers=3) as pool:
        auth = pool.submit(ghops.require_auth)
        repo = pool.submit(ghops.resolve, root)
        branch = pool.submit(gitops.current_branch, root)
        auth.result()
        return root, repo.result(), branch.result()


def build_plan(cwd: Path, home: Path) -> Plan:
    root, repo, branch = preflight(cwd)
    config, layers = load(root, home)
    action_ref = resolve_action_ref(config, repo.name_with_owner)

    changes = []
    for spec in config.workflows:
        rendered = render(config, spec, action_ref, root, home)
        deployed_path = root / spec.path
        deployed = deployed_path.read_text() if deployed_path.is_file() else None
        changes.append(WorkflowChange(rendered=rendered, deployed=deployed))

    return Plan(
        root=root,
        repo=repo,
        branch=branch,
        config=config,
        action_ref=action_ref,
        layers=layers,
        changes=tuple(changes),
    )


def describe(plan: Plan) -> None:
    sources = ", ".join(str(p) for p in plan.layers) or "the shipped defaults only"
    say(f"repo     {plan.repo.name_with_owner} on {plan.branch}")
    say(f"config   {sources}")
    say(f"action   {plan.action_ref}")
    for change in plan.changes:
        say(f"workflow {change.verb:9} {change.rendered.path}  ({change.rendered.template_file})")
    for name, credential in sorted(plan.config.secrets.items()):
        say(f"secret   sync      {name}  (keychain item {credential.item})")


def _converge_secret(repo: str, name: str, item: str) -> None:
    """Re-sync one secret from the keychain, which is its canonical copy.

    Three states, and each is a different fact about the world:
    reachable keychain → re-sync, so a rotated credential propagates on the next review;
    unreachable keychain but the secret already on the repo → the observable desired
    state holds, warn that re-syncing is impossible from this machine;
    unreachable keychain and no copy → fail, because the reviewer cannot authenticate
    and a later "clean review" would be a lie. [LAW:one-source-of-truth]
    """
    if keychain.has_item(item):
        ghops.sync_secret(repo, name, item)
        say(f"✓ synced {name} on {repo} (Actions + Dependabot) from keychain item {item}")
        return
    if ghops.secret_exists(repo, name):
        warn(
            f"! {name} is set on {repo} but keychain item {item!r} is not on this machine,\n"
            f"  so it cannot be re-synced from here; the existing repo secret is left as-is.\n"
            f"  To re-enable syncing: add keychain item {item!r} on this machine."
        )
        return
    raise EffectError(
        f"{name} is not set on {repo} and keychain item {item!r} is not available to set "
        f"it — the reviewer cannot authenticate. Add that keychain item and re-run."
    )


def apply(plan: Plan) -> None:
    """Perform the plan: write what differs, re-sync every secret, land the result."""
    with ThreadPoolExecutor(max_workers=max(1, len(plan.config.secrets))) as pool:
        # Submitted first so the network writes are in flight while the local ones run.
        secrets = [
            pool.submit(_converge_secret, plan.repo.name_with_owner, name, credential.item)
            for name, credential in sorted(plan.config.secrets.items())
        ]
        _write_workflows(plan)
        for secret in secrets:
            secret.result()

    _land(plan)


def _write_workflows(plan: Plan) -> None:
    for change in plan.changes:
        if not change.changed:
            say(f"✓ {change.rendered.path} is up to date")
            continue
        target = plan.root / change.rendered.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(change.rendered.text)
        say(f"✓ {change.verb}d {change.rendered.path} (uses {plan.action_ref})")


def _land(plan: Plan) -> None:
    """Commit the changed workflows onto the current branch and push them.

    The commit rides the branch the caller is already working on, so a template change
    reaches the open PR without costing anyone a second PR to review and merge. On the
    default branch it does not: that would push a workflow change straight to the branch
    every other PR is cut from, unreviewed. The file is still written — reporting the
    commit as the caller's is a fact about where we are, not a failure.
    """
    paths = plan.changed_paths
    if not paths:
        return
    if plan.on_default_branch:
        warn(
            f"! {', '.join(paths)} changed, but {plan.branch} is the default branch — "
            f"not committing.\n  Branch, then commit and push it with your own PR."
        )
        return
    sha = gitops.commit(plan.root, paths, plan.config.commit_message)
    gitops.push(plan.root, plan.branch)
    say(f"✓ committed {sha} and pushed to {plan.branch}: {', '.join(paths)}")
