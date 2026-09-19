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
    name: str | None = None
    runs_on: Any = Field(default=None, alias="runs-on")
    timeout_minutes: int | None = Field(default=None, alias="timeout-minutes")
    steps: list[Step] = Field(default_factory=list)


class Workflow(Node):
    """A whole workflow document, comments included.

    `trivia` is the document's comments, as data. A workflow's comments are the only
    place its security posture is explained — why the trigger is `pull_request`, why
    the untrusted checkout does not persist credentials — so they are part of what a
    render has to carry, not formatting to be discarded on the way through.
    [LAW:no-silent-failure]
    """

    name: str
    on: dict[str, Any]
    permissions: dict[str, str] | None = None
    concurrency: dict[str, Any] | None = None
    jobs: dict[str, Job]
    trivia: tuple[Trivia, ...] = ()


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
        data, trivia = yamldoc.load(text, source)
    except yamldoc.YamlError as exc:
        raise WorkflowError(str(exc)) from exc
    if not isinstance(data, dict):
        raise WorkflowError(
            f"{source}: a workflow is a mapping at the top level, got "
            f"{type(data).__name__}."
        )
    try:
        return Workflow.model_validate({**data, "trivia": trivia})
    except ValidationError as exc:
        detail = "\n".join(
            f"  {'.'.join(str(p) for p in error['loc']) or '(root)'}: {error['msg']}"
            for error in exc.errors()
        )
        raise WorkflowError(f"{source}: not a workflow this installer can bind —\n{detail}") from exc


def _review_steps(workflow: Workflow) -> list[Step]:
    return [
        step for job in workflow.jobs.values() for step in job.steps if step.id == REVIEW_STEP_ID
    ]


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
    bound = old.model_copy(update={"uses": binding.action_ref, "with_": binding.step_with})
    return workflow.model_copy(
        update={
            "jobs": {
                name: job.model_copy(
                    update={"steps": [bound if step is old else step for step in job.steps]}
                )
                for name, job in workflow.jobs.items()
            },
            "trivia": _rehome(workflow.trivia, _path_of(workflow, old), old.with_ or {}, bound.with_ or {}),
        }
    )


def _path_of(workflow: Workflow, target: Step) -> yamldoc.NodePath:
    for job_name, job in workflow.jobs.items():
        for index, step in enumerate(job.steps):
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
    kept = tuple(item for item in workflow.trivia if not (item.path == () and item.key is None))
    banner = Trivia(
        path=(),
        key=None,
        slot=yamldoc.NODE_COMMENT_SLOT,
        comments=(yamldoc.CommentSpec(text=header, column=0),),
    )
    return workflow.model_copy(update={"trivia": (banner, *kept)})


def render(workflow: Workflow) -> str:
    """Serialize back to YAML, comments and all."""
    data = workflow.model_dump(by_alias=True, exclude_none=True, exclude={"trivia"})
    return yamldoc.emit(data, workflow.trivia)
