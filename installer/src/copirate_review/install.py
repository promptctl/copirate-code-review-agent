"""Converge a repository onto its configuration: render, compare, act on the difference.

The run is described before any of it is performed. `build_plan` reads the world and
produces a `Plan` — every write the run will make, and no write made yet; `apply`
performs exactly that plan. `--dry-run` is the same plan with `apply` never called,
which is why it can be trusted to predict a real run. [LAW:effects-at-boundaries]
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
class Land:
    """A commit may be made here, and pushed to this branch."""

    branch: str


@dataclass(frozen=True)
class Hold:
    """No commit may be made here, for this reason."""

    reason: str


#: Where the installer's commit goes, or why it goes nowhere. Committing is not a
#: question of one flag ("am I on the default branch") — a repository has several states
#: in which a commit is wrong or impossible, and enumerating them at the moment of the
#: commit is how the ones nobody thought of get mishandled silently. One value carries
#: the answer, and its producer is the only thing that knows the states.
#: [LAW:types-are-the-program] [LAW:dataflow-not-control-flow]
Landing = Land | Hold


def landing_for(branch: str | None, default_branch: str | None) -> Landing:
    """Decide where the installer's commit goes. Pure, and the only place that decides.

    Detached HEAD: the commit would be reachable from nothing once HEAD moves, and the
    push has no branch to name — `git push --set-upstream origin HEAD` is rejected as
    not a full refname, so the run would end having created a commit recoverable only
    through the reflog.

    No default branch: GitHub reports none for a repository with no commits, and the
    branch we are on will BECOME the default. Committing to it is the default-branch
    case arriving early, not an exception to it.

    The default branch: pushing a workflow change there puts it, unreviewed, on the
    branch every other PR is cut from.
    """
    if branch is None:
        return Hold("HEAD is detached — a commit here would be reachable from nothing.")
    if default_branch is None:
        return Hold(
            f"this repository has no commits on GitHub yet, so {branch} will become its "
            f"default branch."
        )
    if branch == default_branch:
        return Hold(f"{branch} is the default branch.")
    return Land(branch)


@dataclass(frozen=True)
class Plan:
    """Everything a run will do, computed before it does any of it."""

    root: Path
    repo: Repo
    branch: str | None
    landing: Landing
    config: Config
    action_ref: str
    layers: tuple[Path, ...]
    changes: tuple[WorkflowChange, ...]

    @property
    def changed_paths(self) -> list[str]:
        return [c.rendered.path for c in self.changes if c.changed]


def say(message: str) -> None:
    print(message)


def warn(message: str) -> None:
    print(message, file=sys.stderr)


def preflight(cwd: Path) -> tuple[Path, Repo, str | None]:
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
        landing=landing_for(branch, repo.default_branch),
        config=config,
        action_ref=action_ref,
        layers=layers,
        changes=tuple(changes),
    )


def describe(plan: Plan) -> None:
    sources = ", ".join(str(p) for p in plan.layers) or "the shipped defaults only"
    say(f"repo     {plan.repo.name_with_owner} on {plan.branch or 'a detached HEAD'}")
    say(f"config   {sources}")
    say(f"action   {plan.action_ref}")
    for change in plan.changes:
        say(f"workflow {change.verb:9} {change.rendered.path}  ({change.rendered.template_file})")
    for name, credential in sorted(plan.config.secrets.items()):
        say(f"secret   sync      {name}  (keychain item {credential.item})")
    # Said up front, not after the writes: a dry run has to be able to tell you it will
    # not commit, or its whole purpose — predicting the real run — is unmet.
    if isinstance(plan.landing, Hold) and plan.changed_paths:
        say(f"commit   held      {plan.landing.reason}")


def _converge_secret(repo: str, name: str, item: str) -> None:
    """Re-sync one secret from the keychain, which is its canonical copy.

    Reachable keychain → re-sync, so a rotated credential propagates on the next review.
    Otherwise the repo's own stores are the only evidence, and they answer three ways:
    present in both → the observable desired state holds, warn that re-syncing is
    impossible from here; present in only one → the state is broken and unfixable from
    this machine, so fail rather than report a half-provisioned repo as fine; present in
    neither → fail, because the reviewer cannot authenticate and a later "clean review"
    would be a lie. [LAW:one-source-of-truth] [LAW:no-silent-failure]
    """
    if keychain.has_item(item):
        ghops.sync_secret(repo, name, item)
        say(f"✓ synced {name} on {repo} (Actions + Dependabot) from keychain item {item}")
        return

    missing = ghops.stores_missing(repo, name)
    if not missing:
        warn(
            f"! {name} is set on {repo} but keychain item {item!r} is not on this machine,\n"
            f"  so it cannot be re-synced from here; the existing repo secrets are left as-is.\n"
            f"  To re-enable syncing: add keychain item {item!r} on this machine."
        )
        return
    if len(missing) < len(ghops.SECRET_STORES):
        raise EffectError(
            f"{name} is missing from the {', '.join(missing)} secret store on {repo}, and "
            f"keychain item {item!r} is not available to set it — reviews on "
            f"{'/'.join(missing)}-triggered PRs would run unauthenticated. Add that "
            f"keychain item and re-run."
        )
    raise EffectError(
        f"{name} is not set on {repo} and keychain item {item!r} is not available to set "
        f"it — the reviewer cannot authenticate. Add that keychain item and re-run."
    )


def apply(plan: Plan) -> None:
    """Perform the plan: write what differs, re-sync every secret, land the result."""
    with ThreadPoolExecutor(max_workers=len(plan.config.secrets) + 1) as pool:
        tasks = [
            pool.submit(_converge_secret, plan.repo.name_with_owner, name, credential.item)
            for name, credential in sorted(plan.config.secrets.items())
        ]
        tasks.append(pool.submit(_write_workflows, plan))
        # Every task is drained and every failure kept, rather than the first one raising
        # past the others. A run that could not write the workflow AND could not reach a
        # secret store has two things wrong with it, and an operator told only the first
        # fixes it, re-runs, and is told the second. [LAW:no-silent-failure]
        failures = []
        for task in tasks:
            try:
                task.result()
            except Exception as exc:  # every one is reported below; none is swallowed
                failures.append(exc)

    for extra in failures[1:]:
        warn(f"ERROR: {extra}")
    if failures:
        raise failures[0]

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
    reaches the open PR without costing anyone a second PR to review and merge. Where it
    cannot, the file is still written and the reason is reported — a hold is a fact
    about where we are, not a failure of the install. Which states hold is decided in
    `landing_for`, never here. [LAW:single-enforcer]
    """
    paths = plan.changed_paths
    if not paths:
        return
    if isinstance(plan.landing, Hold):
        warn(
            f"! {', '.join(paths)} changed, but {plan.landing.reason} Not committing.\n"
            f"  Branch, then commit and push it with your own PR."
        )
        return
    sha = gitops.commit(plan.root, paths, plan.config.commit_message)
    gitops.push(plan.root, plan.landing.branch)
    say(f"✓ committed {sha} and pushed to {plan.landing.branch}: {', '.join(paths)}")
