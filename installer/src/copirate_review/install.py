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

from . import ghops, gitops
from .config import Config, load
from .credentials import Credential, is_empty
from .ghops import Repo
from .render import Rendered, render, resolve_action_ref
from .shell import EffectError, decoded


@dataclass(frozen=True)
class Unpublished:
    """This branch has no counterpart on the remote: it has never been pushed.

    Not the same as a remote branch that lacks the file, and the difference decides
    whether the installer may push. A branch nobody has published is not BEHIND — it is
    private, and publishing it is the developer's call, not a side effect of converging
    a workflow. Whatever the installer commits here rides their own first push.
    """


@dataclass(frozen=True)
class Published:
    """The remote branch exists; `content` is its copy of this path, if it has one."""

    content: str | None


#: What the remote branch holds for one path. A `str | None` cannot say this: `None`
#: would have to mean both "the remote branch lacks the file" and "there is no remote
#: branch", and those two demand opposite actions. [LAW:types-are-the-program]
RemoteCopy = Unpublished | Published


@dataclass(frozen=True)
class WorkflowChange:
    """One workflow's desired text beside each of the three places it has to reach.

    Three snapshots, because "is this converged?" genuinely has three answers and only
    one boolean was being kept — the one for the WORKING TREE, which is the single place
    that does not determine what the repository runs. GitHub runs what is pushed.

    Every path that writes the file without landing it produced a state the next run
    could not repair: held on the default branch, or a secret sync failing after the
    write, left the file on disk and nothing in git. A later run then compared the
    rendered text to that file, found them equal, reported the workflow up to date, and
    committed nothing — for as many runs as anyone cared to make. A repo with no
    reviewer, and an installer saying it was fine. [LAW:types-are-the-program]

    `None` means the content is absent from that place, which is ordinary: a new
    workflow, an unpushed branch, a repo with no commits.
    """

    rendered: Rendered
    worktree: str | None
    committed: str | None
    remote: RemoteCopy

    @property
    def needs_write(self) -> bool:
        return self.worktree != self.rendered.text

    @property
    def needs_commit(self) -> bool:
        return self.committed != self.rendered.text

    @property
    def needs_push(self) -> bool:
        """Whether the remote branch is BEHIND on this path — never merely absent."""
        return isinstance(self.remote, Published) and self.remote.content != self.rendered.text

    @property
    def verb(self) -> str:
        """How far the content has reached, for the plan the operator reads.

        Named for what the REPOSITORY gets, not for what happens to the file on disk —
        writing the file is not the deliverable, and a line saying "unchanged" about a
        workflow that has never been committed is the exact lie this type now prevents.
        """
        if self.committed is None:
            return "create"
        if self.needs_commit:
            return "update"
        if self.needs_push:
            return "push"
        return "unchanged"


@dataclass(frozen=True)
class SyncSecret:
    """The source holds it: write it to both stores, so a rotation propagates."""

    name: str
    credential: Credential


@dataclass(frozen=True)
class KeepSecret:
    """No local copy, but both stores already hold it. Warn, and leave them alone."""

    name: str
    credential: Credential


@dataclass(frozen=True)
class MissingSecret:
    """No local copy, and the repo's stores cannot be repaired from this machine."""

    name: str
    credential: Credential
    reason: str


#: What one declared secret needs. Decided while the plan is built rather than midway
#: through performing it, because `--dry-run` is only worth running if it reaches the
#: same verdict the real run will: a plan that prints `sync` and exits 0 where the run
#: exits 1 predicts nothing. Asking a source whether it holds the credential is a local
#: check, so the prediction costs milliseconds. [LAW:effects-at-boundaries]
SecretPlan = SyncSecret | KeepSecret | MissingSecret


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
    remote: str
    upstream: str | None
    landing: Landing
    config: Config
    action_ref: str
    layers: tuple[Path, ...]
    changes: tuple[WorkflowChange, ...]
    secrets: tuple[SecretPlan, ...]

    @property
    def commit_paths(self) -> list[str]:
        return [c.rendered.path for c in self.changes if c.needs_commit]

    @property
    def blocked_by(self) -> tuple[str, ...]:
        """Why this plan cannot be carried out, empty when it can.

        Read by BOTH paths, which is the point. `apply` raises these while performing
        the plan; a dry run has nothing to perform, so without this it printed
        `MISSING` and exited 0 while the run it claims to predict exited 1. A gate
        scripted on `copirate-review install --dry-run; echo $?` then passes clean on a
        repository whose reviewer cannot authenticate — the exact shape of lie the
        plan's own contract was written to forbid, one verdict further along than
        where it was caught. [LAW:one-source-of-truth]
        """
        return tuple(s.reason for s in self.secrets if isinstance(s, MissingSecret))

    @property
    def unlanded_paths(self) -> list[str]:
        """Paths the remote branch does not yet carry, whatever is still missing.

        One list for the landing step, because commit-then-push and push-alone are the
        same errand with a different amount left to do: a run whose commit succeeded and
        whose push failed has to push on the next run, and asking only "did anything
        change?" is what made that run a no-op forever. [LAW:dataflow-not-control-flow]
        """
        return [c.rendered.path for c in self.changes if c.needs_commit or c.needs_push]


def say(message: str) -> None:
    print(message)


def warn(message: str) -> None:
    print(message, file=sys.stderr)


def preflight(cwd: Path) -> tuple[Path, Repo, str | None, str]:
    """Establish the preconditions both targets need, each failing with its own cause.

    Credentials are deliberately absent: each is an input to exactly one effect, and is
    demanded only at the moment that effect must write. A run that changes nothing needs
    no credential and must not stop for one.

    `gh auth status` is resolved before the repo lookup even though the lookup subsumes
    it — an unauthenticated gh makes every request fail, and "not a GitHub repo, or no
    access" would send the operator hunting a remote that is fine.
    [LAW:no-silent-failure]

    Branch and remote are read first and serially: they are local git reads costing
    milliseconds, and the remote's URL is what the repo lookup is ABOUT, so the two
    network calls cannot start until it is known. Only they are worth a pool.
    """
    root = gitops.repo_root(cwd)
    ghops.require_cli()
    branch = gitops.current_branch(root)
    remote = gitops.push_remote(root, branch)
    url = gitops.remote_url(root, remote)
    with ThreadPoolExecutor(max_workers=2) as pool:
        auth = pool.submit(ghops.require_auth)
        repo = pool.submit(ghops.resolve, url)
        auth.result()
        return root, repo.result(), branch, remote


def snapshot(root: Path, rendered: Rendered, upstream: str | None) -> WorkflowChange:
    """Read how far this rendered text has already reached, from each place in turn.

    The reads live together because they answer one question and are only ever right
    together — the whole defect was one of them standing in for all three.
    [LAW:one-source-of-truth]
    """
    worktree_path = root / rendered.path
    return WorkflowChange(
        rendered=rendered,
        # Read as BYTES and decoded here, for the reason `output_or_none` is: `read_text`
        # translates line endings, and the two reads have to be honest together. Fixing
        # only the blob leaves `needs_commit` true while `needs_write` is false, so
        # nothing is rewritten, `git add` produces an identical blob, and the commit dies
        # with "nothing to commit" on every run. [LAW:one-type-per-behavior]
        worktree=(
            decoded(worktree_path.read_bytes(), str(worktree_path))
            if worktree_path.is_file()
            else None
        ),
        committed=gitops.blob_at(root, "HEAD", rendered.path),
        remote=(
            Published(gitops.blob_at(root, upstream, rendered.path))
            if upstream is not None
            else Unpublished()
        ),
    )


def plan_secret(repo: str, name: str, credential: Credential) -> SecretPlan:
    """Decide what one secret needs, from its declared source and the repo's two stores.

    The declared source is the canonical copy, so reaching it means re-syncing and a
    rotated credential propagates. Without it the stores are the only evidence, and they
    answer three ways: both hold it → the observable desired state already holds; one
    holds it → broken in a way this machine cannot repair, and the other store's PRs
    would review unauthenticated; neither → the reviewer cannot authenticate at all, and
    a later "clean review" would be a lie. [LAW:one-source-of-truth]
    [LAW:no-silent-failure]

    "Holds it" means holds a VALUE. An exported-but-empty variable, or a keychain item
    stored empty, passes `present()` and is refused at the write — so the plan said
    `sync` and exited 0 while the run it was predicting exited 1. A dry run may be
    wrong about the network; it may not be wrong about this machine. Asking here also
    lets a repo whose stores already hold a good secret report `keep` rather than
    failing the whole run over a local source that has gone empty.
    """
    present = credential.present()
    empty = present and is_empty(credential)
    if present and not empty:
        return SyncSecret(name, credential)

    # Named for what is actually wrong, because "provide that credential" is the wrong
    # instruction for one that is sitting right there, empty. [LAW:no-silent-failure]
    unusable = (
        f"{credential.description} holds an empty value"
        if empty
        else f"{credential.description} is not available"
    )
    missing = ghops.stores_missing(repo, name)
    if not missing:
        return KeepSecret(name, credential)
    if len(missing) < len(ghops.SECRET_STORES):
        return MissingSecret(
            name,
            credential,
            f"{name} is missing from the {', '.join(missing)} secret store on {repo}, and "
            f"{unusable} to set it — reviews on "
            f"{'/'.join(missing)}-triggered PRs would run unauthenticated. Provide that "
            f"credential and re-run.",
        )
    return MissingSecret(
        name,
        credential,
        f"{name} is not set on {repo} and {unusable} to set it — the reviewer cannot "
        f"authenticate. Provide that credential and re-run.",
    )


def build_plan(cwd: Path, home: Path) -> Plan:
    root, repo, branch, remote = preflight(cwd)
    config, layers = load(root, home)
    action_ref = resolve_action_ref(config, repo.name_with_owner)
    upstream = gitops.upstream_ref(root, branch, remote)

    changes = [
        snapshot(root, render(config, spec, action_ref, root, home), upstream)
        for spec in config.workflows
    ]

    declared = sorted(config.secrets.items())
    with ThreadPoolExecutor(max_workers=max(len(declared), 1)) as pool:
        secrets = [
            future.result()
            for future in [
                pool.submit(plan_secret, repo.name_with_owner, name, credential)
                for name, credential in declared
            ]
        ]

    return Plan(
        root=root,
        repo=repo,
        branch=branch,
        remote=remote,
        upstream=upstream,
        landing=landing_for(branch, repo.default_branch),
        config=config,
        action_ref=action_ref,
        layers=layers,
        changes=tuple(changes),
        secrets=tuple(secrets),
    )


def describe(plan: Plan) -> None:
    sources = ", ".join(str(p) for p in plan.layers) or "the shipped defaults only"
    say(
        f"repo     {plan.repo.name_with_owner} ({plan.remote}) on "
        f"{plan.branch or 'a detached HEAD'}"
    )
    say(f"config   {sources}")
    say(f"action   {plan.action_ref}")
    for change in plan.changes:
        say(f"workflow {change.verb:9} {change.rendered.path}  ({change.rendered.base_file})")
    for secret in plan.secrets:
        say(f"secret   {_secret_verb(secret):9} {secret.name}  ({_secret_detail(secret)})")
    # Said up front, not after the writes: a dry run has to be able to tell you it will
    # not commit — or will commit and not push — or its whole purpose is unmet.
    if isinstance(plan.landing, Hold) and plan.unlanded_paths:
        say(f"commit   held      {plan.landing.reason}")
    elif plan.upstream is None and plan.unlanded_paths:
        say(
            f"push     held      {plan.branch} is not on {plan.remote} yet; "
            f"your next push carries it"
        )


def _secret_verb(secret: SecretPlan) -> str:
    return {SyncSecret: "sync", KeepSecret: "keep", MissingSecret: "MISSING"}[type(secret)]


def _secret_detail(secret: SecretPlan) -> str:
    if isinstance(secret, SyncSecret):
        return secret.credential.description
    if isinstance(secret, KeepSecret):
        return f"{secret.credential.description} is unavailable here; both stores have it"
    return f"{secret.credential.description} is unavailable here"


def _converge_secret(repo: str, secret: SecretPlan) -> None:
    """Perform one secret's decision. The deciding was done when the plan was built."""
    if isinstance(secret, SyncSecret):
        ghops.sync_secret(repo, secret.name, secret.credential)
        say(
            f"✓ synced {secret.name} on {repo} (Actions + Dependabot) "
            f"from {secret.credential.description}"
        )
        return
    if isinstance(secret, KeepSecret):
        warn(
            f"! {secret.name} is set on {repo} but {secret.credential.description} is not "
            f"available here,\n  so it cannot be re-synced from this machine; the existing "
            f"repo secrets are left as-is.\n  To re-enable syncing: provide "
            f"{secret.credential.description}."
        )
        return
    raise EffectError(secret.reason)


def apply(plan: Plan) -> None:
    """Perform the plan: write what differs, re-sync every secret, land the result."""
    with ThreadPoolExecutor(max_workers=len(plan.secrets) + 1) as pool:
        tasks = [
            pool.submit(_converge_secret, plan.repo.name_with_owner, secret)
            for secret in plan.secrets
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
    """Make each workflow file on disk match its base.

    This step speaks only about the FILE. What the repository ends up running is the
    landing step's sentence to say, and merging the two is how "wrote the file" came to
    be reported as if it meant "the repo has it". [LAW:decomposition]
    """
    for change in plan.changes:
        if not change.needs_write:
            say(f"✓ {change.rendered.path} matches its base")
            continue
        target = plan.root / change.rendered.path
        # The filesystem is as much "the world" as gh is, and it refuses for the same
        # kinds of reason: a read-only mount, a directory that is really a file, a
        # permission. Translated here so it reaches the exit-code contract as the `1` it
        # is, rather than as a traceback carrying whatever code the interpreter picked.
        # [LAW:parse-dont-validate]
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(change.rendered.text)
        except OSError as exc:
            raise EffectError(f"could not write {target}: {exc}") from exc
        say(f"✓ wrote {change.rendered.path} (uses {plan.action_ref})")


def _land(plan: Plan) -> None:
    """Commit the changed workflows onto the current branch and push them.

    The commit rides the branch the caller is already working on, so a base change
    reaches the open PR without costing anyone a second PR to review and merge. Where it
    cannot, the file is still written and the reason is reported — a hold is a fact
    about where we are, not a failure of the install. Which states hold is decided in
    `landing_for`, never here. [LAW:single-enforcer]

    The push is NOT conditional on having just committed. A run that committed and then
    failed to push leaves work whose only remaining step is a push, and gating that on a
    fresh change means the next run — and every run after it — does nothing while the
    pull request still has no workflow.

    It is conditional on the branch already existing on the remote. This tool converges
    a workflow; it does not decide that someone's local branch should become public, and
    a push is the one step here that cannot be taken back.
    """
    unlanded = plan.unlanded_paths
    if not unlanded:
        return
    if isinstance(plan.landing, Hold):
        warn(
            f"! {', '.join(unlanded)} is not on {plan.remote} yet, but "
            f"{plan.landing.reason} Not committing.\n"
            f"  Branch, then commit and push it with your own PR."
        )
        return

    to_commit = plan.commit_paths
    if to_commit:
        sha = gitops.commit(plan.root, to_commit, plan.config.commit_message)
        say(f"✓ committed {sha}: {', '.join(to_commit)}")
    if plan.upstream is None:
        warn(
            f"! {plan.landing.branch} is not on {plan.remote} yet, so nothing was pushed "
            f"— publishing your branch is your call, not this installer's.\n"
            f"  Your next push carries {', '.join(unlanded)}."
        )
        return
    gitops.push(plan.root, plan.landing.branch, plan.remote)
    say(f"✓ pushed {plan.landing.branch} to {plan.remote}: {', '.join(unlanded)}")
