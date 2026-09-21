"""A GitHub Actions workflow as typed objects, and the one transformation applied to it.

The installer does not template workflows. It reads a base — a complete, runnable
workflow — into these models, rebinds one step from the configuration, and writes the
result back. There is no expression language, no delimiter collision with Actions'
own `${{ }}`, and no class of bug where a base renders into something that is not YAML:
the output is serialized from a parsed object, so it is well-formed by construction.
[LAW:types-are-the-program]

What is modelled is what the installer TRANSFORMS, and unknown keys are carried
through verbatim. That is the strongest theorem that is still true: a workflow may use
`strategy`, `services`, `outputs`, or a key GitHub adds next month, and a model that
forbade them would reject valid bases while a model that claimed to understand them
would be lying. Everything declared here, the transformation can reason about;
everything else is data in transit.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import yamldoc
from .yamldoc import Trivia

#: The step a rendered workflow's configuration binds to, identified by the `id` GitHub
#: Actions already gives it. The id is not a marker invented for the installer: the
#: base's own transcript-archiving step reads `steps.review.outputs.transcript-dir`, so
#: this id is load-bearing INSIDE the base whether or not anything here looked at it.
#: Anchoring to the same one adds no coupling that was not already there, and the
#: alternative — matching a step by its `uses:` ref — cannot work, because rebinding
#: that ref is the entire job. [LAW:one-source-of-truth]
REVIEW_STEP_ID = "review"


class WorkflowError(Exception):
    """A base the installer cannot bind, with the file named."""


class Node(BaseModel):
    """Typed where the installer looks, transparent everywhere else.

    `populate_by_name` lets `with_` and `if_` carry Actions' `with:` and `if:` — which
    are Python keywords — without any caller having to know the difference.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Step(Node):
    """One step. `uses` and `with_` are the two fields a binding rewrites."""

    name: str | None = None
    id: str | None = None
    if_: str | None = Field(default=None, alias="if")
    continue_on_error: bool | None = Field(default=None, alias="continue-on-error")
    uses: str | None = None
    run: str | None = None
    with_: dict[str, Any] | None = Field(default=None, alias="with")


class Job(Node):
    """A job. `steps` is absent, not empty, for a job that calls a reusable workflow.

    The distinction is not pedantry: rendering `steps: []` into such a job produces a
    workflow GitHub rejects, so "has no steps key" and "has an empty steps list" cannot
    share a value. [LAW:types-are-the-program]
    """

    name: str | None = None
    runs_on: Any = Field(default=None, alias="runs-on")
    timeout_minutes: int | None = Field(default=None, alias="timeout-minutes")
    steps: list[Step] | None = None


class Workflow(Node):
    """A whole workflow document, comments included.

    `layout` is everything about the document the model's fields do not hold: its
    comments and the order its keys were written in. A workflow's comments are the
    only place its security posture is explained — why the trigger is `pull_request`,
    why the untrusted checkout does not persist credentials — so they are part of what
    a render has to carry, not formatting to be discarded on the way through. The order
    is carried for the same reason and not a weaker one: ruamel attaches a comment to
    the node BEFORE it, so reordering keys moves comments onto the wrong lines.
    [LAW:no-silent-failure]
    """

    # `on`, `permissions` and `concurrency` are deliberately untyped beyond "present".
    # Each has several legal shapes — `on: push`, `on: [push, pull_request]`, the mapping
    # form; `permissions: read-all` beside the per-scope mapping; `concurrency: my-group`
    # beside the mapping — and the installer transforms none of them. A narrower
    # annotation here would be a theorem STRONGER than the truth, which rejects valid
    # bases just as surely as a weak one admits invalid states. `name` is optional
    # because GitHub falls back to the file path. [LAW:types-are-the-program]
    name: str | None = None
    on: Any
    permissions: Any = None
    concurrency: Any = None
    jobs: dict[str, Job]
    layout: yamldoc.Layout = yamldoc.Layout()


class Binding(BaseModel):
    """What the configuration says the review step must carry.

    The three things a repository gets to decide, and the whole interface between
    configuration and workflow shape. Everything else about a rendered workflow comes
    from its base.
    """

    model_config = ConfigDict(frozen=True)

    action_ref: str
    secrets: tuple[str, ...]
    inputs: Mapping[str, str]

    @property
    def step_with(self) -> dict[str, str]:
        """The `with:` block: every declared secret, then every declared input.

        Declaring a secret provisions it AND passes it, so a repository never wires a
        credential in two places. The two tables cannot collide — the configuration
        boundary refuses that shape before a `Binding` can be built.
        """
        wired = {name: f"${{{{ secrets.{name} }}}}" for name in self.secrets}
        return {
            name: yamldoc.quoted(value)
            for name, value in {**wired, **dict(sorted(self.inputs.items()))}.items()
        }


def parse(text: str, source: str) -> Workflow:
    """Read a base into a `Workflow`, or refuse it naming the file and the field.

    A base is a file an operator wrote, so a malformed one is their error to fix and
    reaches them as such — never as a traceback from three frames inside pydantic.
    [LAW:parse-dont-validate]
    """
    try:
        data, layout = yamldoc.load(text, source)
    except yamldoc.YamlError as exc:
        raise WorkflowError(str(exc)) from exc
    if not isinstance(data, dict):
        raise WorkflowError(
            f"{source}: a workflow is a mapping at the top level, got "
            f"{type(data).__name__}."
        )
    try:
        return Workflow.model_validate({**data, "layout": layout})
    except ValidationError as exc:
        detail = "\n".join(
            f"  {'.'.join(str(p) for p in error['loc']) or '(root)'}: {error['msg']}"
            for error in exc.errors()
        )
        raise WorkflowError(f"{source}: not a workflow this installer can bind —\n{detail}") from exc


def _review_steps(workflow: Workflow) -> list[Step]:
    return [
        step
        for job in workflow.jobs.values()
        for step in (job.steps or ())
        if step.id == REVIEW_STEP_ID
    ]


#: An Actions expression — the ONLY place `needs.…` means anything. Matched first so the
#: checks below read references and never prose: an input whose value merely contains the
#: words "needs.something" is text, and failing an install over it would be a false alarm
#: about a value GitHub passes through untouched. [LAW:parse-dont-validate]
_EXPRESSION = re.compile(r"\$\{\{(.*?)\}\}", re.S)

#: Any `needs.<job>` reference, whatever is read off it — `.outputs.x`, `.result`, all of it.
#: The job segment is what must name a declared dependency.
_NEEDS_JOB = re.compile(r"\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)")

#: A `needs.<job>.outputs.<name>` reference, where BOTH halves are checkable: the job must be
#: a declared dependency, and the name must be an output that job actually publishes.
_NEEDS_OUTPUT = re.compile(r"\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)")


def _expressions(value: str) -> list[str]:
    return _EXPRESSION.findall(str(value))


def _declared_outputs(job: Job) -> frozenset[str]:
    """The output names this job publishes. `outputs:` is carried through, not modelled."""
    outputs = (job.model_extra or {}).get("outputs")
    return frozenset(outputs) if isinstance(outputs, Mapping) else frozenset()


def _declared_needs(job: Job) -> frozenset[str]:
    """The jobs this job declares it needs, in either shape GitHub accepts.

    `needs:` is not modelled on `Job` — it is carried through as data like every other
    key the installer does not transform — so it is read here rather than annotated.
    A scalar (`needs: gate`) and a list (`needs: [gate, setup]`) are the same fact in two
    notations, so they resolve to one set. [LAW:one-type-per-behavior]
    """
    needs = (job.model_extra or {}).get("needs")
    if needs is None:
        return frozenset()
    if isinstance(needs, str):
        return frozenset({needs})
    return frozenset(str(n) for n in needs)


def _refuse_unsatisfiable_needs(
    workflow: Workflow, job_name: str, job: Job, binding: Binding, source: str
) -> None:
    """Refuse a binding whose inputs read a job output the review step cannot see.

    WHY THIS IS A PARSE AND NOT A DOC COMMENT. The base and the configuration's inputs
    table are two files, and `comment-review` couples them: it declares a `gate` job and
    the configuration feeds `needs.gate.outputs.*` into the review step. Nothing in
    Actions objects when that coupling breaks — `needs.gate.outputs.pr-number` against a
    review job that never declared `needs: gate` evaluates to THE EMPTY STRING, so the
    workflow is valid, the run starts, and the action is handed nothing.

    The shape that reaches this is ordinary, not exotic: the shipped `defaults.yaml` binds
    those two inputs, `merge()` deep-merges layers, so a repository that overrides nothing
    but `base: pr-review` keeps them and renders a review job pointing at a job that base
    does not have. The blast radius is every consuming repository that pins the old base.

    THE DIVISION OF LABOUR, so this does not grow a second copy of a rule GitHub owns:
      - a `needs:` naming a job that does not exist → GitHub rejects the workflow outright;
      - a reference to a job the review step's job did not declare → checked here, first
        branch, because GitHub resolves it to '' instead of complaining;
      - a MISSPELLED output on a correctly-declared job → also '', also silent to GitHub,
        so it is checked here too, second branch. `HEAD_SHA: needs.gate.outputs.head_sha`
        against a gate publishing `head-sha` is one underscore and a review of nothing.

    Read only inside `${{ }}`: outside an expression `needs.x` is text GitHub passes
    through, and failing an install over prose would be a false alarm.
    [LAW:parse-dont-validate] [LAW:no-silent-failure]
    """
    available = _declared_needs(job)
    for name, value in sorted(binding.inputs.items()):
        for expression in _expressions(value):
            for referenced in _NEEDS_JOB.findall(expression):
                if referenced in available:
                    continue
                raise WorkflowError(
                    f"{source}: input {name} reads `needs.{referenced}`, but the job holding "
                    f"the `id: {REVIEW_STEP_ID}` step ({job_name}) declares "
                    + (
                        f"needs: {', '.join(sorted(available))}"
                        if available
                        else "no `needs:`"
                    )
                    + f". Either use a base whose {job_name} job declares `needs: {referenced}`, "
                    f"or drop {name} from the inputs table — as written it would render a "
                    f"workflow GitHub accepts and then pass the action an empty value."
                )
            for referenced, output in _NEEDS_OUTPUT.findall(expression):
                producer = workflow.jobs.get(referenced)
                # A job absent from this workflow is GitHub's refusal to make, not ours, and a
                # job publishing no `outputs:` at all is a base too different to second-guess.
                if producer is None:
                    continue
                published = _declared_outputs(producer)
                if not published or output in published:
                    continue
                raise WorkflowError(
                    f"{source}: input {name} reads `needs.{referenced}.outputs.{output}`, but "
                    f"the {referenced} job publishes "
                    f"{', '.join(sorted(published))}. Actions resolves an unknown output to "
                    f"the empty string, so this would render a valid workflow that hands the "
                    f"action nothing — check the output's spelling."
                )


def bind(workflow: Workflow, binding: Binding, source: str) -> Workflow:
    """Point the review step at the configured action, carrying the configured bindings.

    Pure: a new `Workflow` out, the argument untouched. Nothing here reads a file, a
    repository, or a clock, which is what lets the caller compare the result against
    what is deployed before performing anything. [LAW:effects-at-boundaries]

    The `with:` block is REPLACED, not merged into. Merging would make a base's own
    `with:` a second table of defaults competing with the configuration's, and the
    losing one would be invisible — a value set in the base and overridden three layers
    away, with nothing to say which won. [LAW:one-source-of-truth]
    """
    found = _review_steps(workflow)
    if len(found) != 1:
        raise WorkflowError(
            f"{source}: a base needs exactly one step with `id: {REVIEW_STEP_ID}` — the "
            f"step this installer points at the review action — and this one has "
            f"{len(found)}."
        )
    old = found[0]
    # The job that holds the review step, because that job's `needs:` is what decides
    # whether the configuration's inputs can see the outputs they reference.
    job_name, review_job = next(
        (name, job) for name, job in workflow.jobs.items() if old in (job.steps or ())
    )
    _refuse_unsatisfiable_needs(workflow, job_name, review_job, binding, source)
    bound = old.model_copy(update={"uses": binding.action_ref, "with_": binding.step_with})
    return workflow.model_copy(
        update={
            "jobs": {
                name: job.model_copy(
                    update={
                        "steps": [bound if step is old else step for step in job.steps]
                        if job.steps is not None
                        else None
                    }
                )
                for name, job in workflow.jobs.items()
            },
            "layout": workflow.layout.model_copy(
                update={
                    "trivia": _rehome(
                        workflow.layout.trivia,
                        _path_of(workflow, old),
                        old.with_ or {},
                        bound.with_ or {},
                    )
                }
            ),
        }
    )


def _path_of(workflow: Workflow, target: Step) -> yamldoc.NodePath:
    for job_name, job in workflow.jobs.items():
        for index, step in enumerate(job.steps or ()):
            if step is target:
                return ("jobs", job_name, "steps", index)
    raise WorkflowError("the review step vanished between finding it and binding it")


def _rehome(
    trivia: tuple[Trivia, ...],
    step: yamldoc.NodePath,
    old_with: Mapping[str, Any],
    new_with: Mapping[str, Any],
) -> tuple[Trivia, ...]:
    """Carry the comment block that FOLLOWED the old `with:` onto the new one.

    Rebinding replaces every key in that block, so every comment keyed to one of them
    is gone with it — correctly, since the configuration wrote those lines. One is not
    about the block at all: ruamel hangs the trivia between a mapping's end and
    whatever comes next off that mapping's LAST key, so the paragraph explaining the
    step AFTER this one lives here too. Dropping it by association deletes a comment
    about code the transformation never touched. [FRAMING:representation]
    """
    with_path = (*step, "with")
    tail_key = list(old_with)[-1] if old_with else None
    new_tail = list(new_with)[-1] if new_with else None
    kept: list[Trivia] = []
    for item in trivia:
        if item.path != with_path:
            kept.append(item)
            continue
        if item.key == tail_key and item.slot in yamldoc.SINGLE_TOKEN_SLOTS and new_tail is not None:
            kept.append(item.model_copy(update={"key": new_tail}))
    return tuple(kept)


def headed(workflow: Workflow, header: str) -> Workflow:
    """Replace the document's leading comment block with `header`.

    A rendered workflow does not inherit its base's opening paragraph. That paragraph
    addresses whoever edits the base; the rendered copy is read by whoever opened a
    repository's `.github/workflows/`, and the first thing they need to know is that
    editing it accomplishes nothing. [FRAMING:representation]
    """
    kept = tuple(
        item for item in workflow.layout.trivia if not (item.path == () and item.key is None)
    )
    banner = Trivia(
        path=(),
        key=None,
        slot=yamldoc.NODE_COMMENT_SLOT,
        comments=(yamldoc.CommentSpec(text=header, column=0),),
    )
    return workflow.model_copy(
        update={"layout": workflow.layout.model_copy(update={"trivia": (banner, *kept)})}
    )


def render(workflow: Workflow) -> str:
    """Serialize back to YAML, comments and all."""
    # `exclude_unset`, NOT `exclude_none`. The two differ exactly where a base writes a
    # key with no value — `timeout-minutes:` — which is a key the document HAS and
    # `exclude_none` deleted, because a field the model names has one representation for
    # "absent" and "present and null". `exclude_unset` asks the question that actually
    # distinguishes them: was this key in the document at all. [LAW:types-are-the-program]
    data = workflow.model_dump(by_alias=True, exclude_unset=True, exclude={"layout"})
    return yamldoc.emit(data, workflow.layout)
