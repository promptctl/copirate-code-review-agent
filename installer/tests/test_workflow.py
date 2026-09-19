"""The workflow model and its codec: what survives a parse, a rebinding, and an emit.

These are the tests that stand where the template engine used to. A template was text
in and text out, so the only thing that could be asserted about it was the text; a base
is parsed into an object, so what is asserted here is that the object is faithful to
the file — including the parts no field of the model names. [LAW:behavior-not-structure]
"""

from __future__ import annotations

from importlib import resources

import pytest

from copirate_review import workflow as wf
from copirate_review.workflow import Binding, Workflow, WorkflowError, bind, parse, render
from copirate_review.yamldoc import emit, load

SHIPPED = resources.files("copirate_review").joinpath("bases", "pr-review.yml").read_text()

MINIMAL = """\
name: Review
on:
  pull_request: {}
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - id: review
        uses: placeholder@v0
        with:
          OLD: 'gone'
"""


def binding(**overrides) -> Binding:
    return Binding(
        **{"action_ref": "o/r@v1", "secrets": ("TOKEN",), "inputs": {"SCOPE": "all"}, **overrides}
    )


# --- the codec --------------------------------------------------------------------


def test_the_shipped_base_survives_a_parse_and_an_emit_byte_for_byte():
    """The invariant the whole comment-preserving codec exists to hold.

    It is also what keeps the base honest: the file an author edits is exactly the file
    the emitter produces, so reviewing a base is reviewing the rendered output.
    """
    data, trivia = load(SHIPPED, "base")
    assert emit(data, trivia) == SHIPPED


def test_a_comment_hanging_off_a_list_item_is_restored_rather_than_dropped():
    """`key in node` is a VALUE test on a list, so this went missing once, in silence."""
    source = "on:\n  pull_request:\n    types:\n      - opened\n\njobs: {}\n"
    data, trivia = load(source, "t")
    assert emit(data, trivia) == source


def test_a_key_the_model_does_not_name_is_carried_through_untouched():
    """A base may use `strategy`, `services`, or a key GitHub adds next month."""
    source = MINIMAL.replace(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres\n",
    )
    rendered = render(bind(parse(source, "t"), binding(), "t"))
    assert "image: postgres" in rendered


def test_a_document_that_is_not_a_mapping_is_refused_naming_what_it_is():
    with pytest.raises(WorkflowError, match="mapping at the top level"):
        parse("- just a list\n", "t")


# --- binding ----------------------------------------------------------------------


def test_binding_replaces_the_ref_and_the_whole_with_block():
    bound = bind(parse(MINIMAL, "t"), binding(), "t")
    step = bound.jobs["review"].steps[0]
    assert step.uses == "o/r@v1"
    assert "OLD" not in step.with_
    assert step.with_ == {"TOKEN": "${{ secrets.TOKEN }}", "SCOPE": "all"}


def test_binding_leaves_the_original_untouched_so_a_plan_can_be_built_before_it_acts():
    original = parse(MINIMAL, "t")
    bind(original, binding(), "t")
    assert original.jobs["review"].steps[0].uses == "placeholder@v0"


def test_every_secret_is_wired_before_every_input_and_inputs_come_out_sorted():
    """Deterministic order, or an unchanged config renders a different file each run."""
    bound = bind(
        parse(MINIMAL, "t"),
        binding(secrets=("B_TOKEN", "A_TOKEN"), inputs={"Z": "1", "A": "2"}),
        "t",
    )
    assert list(bound.jobs["review"].steps[0].with_) == ["B_TOKEN", "A_TOKEN", "A", "Z"]


def test_a_step_with_no_id_is_never_mistaken_for_the_review_step():
    source = MINIMAL.replace("      - id: review\n", "      - name: something else\n")
    with pytest.raises(WorkflowError, match="exactly one step"):
        bind(parse(source, "t"), binding(), "t")


def test_the_review_step_is_found_by_id_and_not_by_the_ref_it_currently_carries():
    """Rebinding that ref is the job, so it cannot also be how the step is recognised."""
    source = MINIMAL.replace("uses: placeholder@v0", "uses: someone/entirely-different@v9")
    assert bind(parse(source, "t"), binding(), "t").jobs["review"].steps[0].uses == "o/r@v1"


def test_the_model_is_not_a_second_place_workflow_defaults_can_live():
    """A base's `with:` is illustrative. Merging would make its values invisible losers."""
    bound = bind(parse(MINIMAL, "t"), binding(secrets=(), inputs={}), "t")
    assert bound.jobs["review"].steps[0].with_ == {}


# --- what a rendered document looks like ------------------------------------------


def test_rendering_a_parsed_base_produces_a_document_that_parses_back_the_same_way():
    bound = bind(parse(SHIPPED, "base"), binding(), "base")
    assert isinstance(parse(render(bound), "rendered"), Workflow)


def test_an_actions_expression_is_never_treated_as_anything_but_text():
    """`${{ }}` collides with a template language's delimiters. It cannot collide here."""
    bound = bind(parse(MINIMAL, "t"), binding(inputs={"REF": "${{ github.sha }}"}), "t")
    assert "${{ github.sha }}" in render(bound)


@pytest.mark.parametrize("value", ["no", "on", "yes", "off", "true", "null", "5", "~"])
def test_an_input_spelling_a_yaml_keyword_is_emitted_quoted(value):
    """Unquoted, the runner reads a boolean where the configuration wrote a string.

    Which words resolve to a boolean differs between YAML 1.1 and 1.2, so the guard is
    unconditional quoting rather than a list of spellings to keep current.
    """
    rendered = render(bind(parse(MINIMAL, "t"), binding(inputs={"SCOPE": value}), "t"))
    assert f'SCOPE: "{value}"' in rendered


def test_the_review_step_id_is_the_one_the_base_already_depends_on():
    """The archive step reads `steps.review.outputs`, so the id was load-bearing already."""
    assert f"steps.{wf.REVIEW_STEP_ID}.outputs" in SHIPPED
