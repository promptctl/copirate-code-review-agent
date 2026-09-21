"""Base resolution and rendering: what lands in a consumer's workflow file."""

from __future__ import annotations

import pytest

from copirate_review.config import ConfigError, load, parse
from copirate_review.yamldoc import load as read_yaml
from copirate_review.render import render, resolve_action_ref

from .test_config import SHIPPED_BASE, WORKFLOW, minimal

TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"


def machine(tmp_path, body=""):
    """A home layer declaring a credential, which every render needs to be legal.

    It lives in the MACHINE layer rather than each repo's, because that is where a
    credential belongs for real: declared once for every repository on a machine. The
    shipped layer declares none, on purpose.
    """
    home = tmp_path / "home"
    (home / ".config/copirate-review").mkdir(parents=True, exist_ok=True)
    (home / ".config/copirate-review/config.yaml").write_text(
        f"secrets:\n  {TOKEN}: keychain:ITEM\n{body}"
    )
    return home


def rendered_for(tmp_path, repo="someone/else", home=None):
    home = home or machine(tmp_path)
    config, _ = load(tmp_path, home)
    return render(config, config.workflows[0], resolve_action_ref(config, repo), tmp_path, home)


def review_step(text):
    """The step a binding rebinds, found the way the installer finds it."""
    workflow, _ = read_yaml(text, "rendered")
    return next(s for s in workflow["jobs"]["review"]["steps"] if s.get("id") == "review")


def declaring(tmp_path, body):
    (tmp_path / ".copirate-review.yaml").write_text(body)
    return tmp_path


# --- the action ref ---------------------------------------------------------------


def test_a_consumer_gets_the_moving_major_tag():
    config = parse(minimal(action_ref="promptctl/copirate-code-review-agent@v1"), "t.yaml")
    assert resolve_action_ref(config, "someone/else") == "promptctl/copirate-code-review-agent@v1"


def test_the_actions_own_repo_reviews_each_pr_with_that_prs_code():
    config = parse(minimal(action_ref="promptctl/copirate-code-review-agent@v1"), "t.yaml")
    assert resolve_action_ref(config, "promptctl/copirate-code-review-agent") == "./"


def test_the_self_review_discriminator_ignores_case_as_github_itself_does():
    """gh reports the canonical casing; `action_ref` carries whatever a human typed.

    An exact comparison misses, and the miss is silent: the action's own repo would
    review its pull requests with the RELEASED ref instead of the code under review.
    """
    config = parse(minimal(action_ref="PromptCtl/CoPirate-Code-Review-Agent@v1"), "t.yaml")
    assert resolve_action_ref(config, "promptctl/copirate-code-review-agent") == "./"


# --- what the rendered workflow contains ------------------------------------------


def test_the_rendered_workflow_is_valid_yaml_carrying_the_declared_bindings(tmp_path):
    step = review_step(rendered_for(tmp_path).text)
    assert step["uses"] == "promptctl/copirate-code-review-agent@v1"
    assert step["with"][TOKEN] == "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"
    assert step["with"]["MAX_REVIEW_ROUNDS"] == "5"


def test_every_declared_secret_is_wired_into_the_step_under_its_own_name(tmp_path):
    root = declaring(tmp_path, "secrets:\n  OPENAI_API_KEY: env:OAI\n")
    step = review_step(rendered_for(root).text)
    assert step["with"]["OPENAI_API_KEY"] == "${{ secrets.OPENAI_API_KEY }}"
    assert step["with"][TOKEN] == "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"


def test_a_deleted_secret_is_neither_provisioned_nor_wired(tmp_path):
    """The fleet layer gave it; this repo reviews on a different provider."""
    root = declaring(tmp_path, f"secrets:\n  {TOKEN}: null\n  ZAI_API_KEY: keychain:ZAI\n")
    step = review_step(rendered_for(root).text)
    assert TOKEN not in step["with"]
    assert step["with"]["ZAI_API_KEY"] == "${{ secrets.ZAI_API_KEY }}"


def test_the_bases_own_with_block_is_replaced_rather_than_merged_into(tmp_path):
    """Otherwise a base is a second table of defaults, and the loser is invisible."""
    step = review_step(rendered_for(tmp_path).text)
    assert set(step["with"]) == {
        TOKEN,
        "DEPENDENCY_DIFF",
        "EXCLUDE_PATTERNS",
        "MAX_REVIEW_ROUNDS",
        "PR_NUMBER",
        "HEAD_SHA",
    }


def test_actions_expressions_survive_rendering_untouched(tmp_path):
    """`${{ }}` is the reason a template language was the wrong tool for this job."""
    text = rendered_for(tmp_path).text
    # One from the base's own body and one from a comment that follows a rebound block,
    # so the assertion covers an expression the rebinding moves past as well as one it
    # never touches.
    assert "${{ needs.gate.outputs.head-sha }}" in text
    assert "${{ steps.review.outputs.transcript-dir }}" in text


def test_the_security_rationale_in_the_base_reaches_the_repository_that_runs_it(tmp_path):
    """Comments are content here: they are the only record of why the shape is safe.

    A renderer that parsed to plain data and emitted plain data would delete all of it
    and pass every other test in this file. [LAW:no-silent-failure]
    """
    text = rendered_for(tmp_path).text
    assert "SECURITY POSTURE" in text
    assert "untrusted-checkout pattern CodeQL flags as high" in text
    assert "persist-credentials: false" in text


def test_a_comment_after_the_rebound_block_survives_the_rebinding(tmp_path):
    """It describes the NEXT step. YAML parsers file it under the previous one."""
    assert "The transcript is the only artifact" in rendered_for(tmp_path).text


def test_the_rendered_file_says_it_is_generated_and_where_to_edit_instead(tmp_path):
    text = rendered_for(tmp_path).text
    assert text.startswith("# GENERATED by `copirate-review install`")
    assert f".copirate-review/bases/{SHIPPED_BASE}.yml" in text


def test_the_header_names_no_path_that_differs_between_two_machines(tmp_path):
    """The rendered file is committed. An absolute path in it churns per developer."""
    header = rendered_for(tmp_path).text.split("name: AI Code Review")[0]
    assert str(tmp_path) not in header
    assert "/Users/" not in header and "/home/" not in header


def test_a_value_carrying_a_quote_is_escaped_rather_than_corrupting_the_yaml(tmp_path):
    root = declaring(
        tmp_path, f'workflows:\n  {WORKFLOW}:\n    inputs:\n      SCOPE: \'say "hi" \\ bye\'\n'
    )
    assert review_step(rendered_for(root).text)["with"]["SCOPE"] == 'say "hi" \\ bye'


@pytest.mark.parametrize("value", ["true", "5", "null", "no", "0x10", "", "@odd"])
def test_an_input_that_looks_like_another_type_still_reaches_the_action_as_a_string(
    tmp_path, value
):
    """`MAX_REVIEW_ROUNDS: 5` unquoted is an int to the next reader of the file."""
    root = declaring(
        tmp_path, f"workflows:\n  {WORKFLOW}:\n    inputs:\n      SCOPE: '{value}'\n"
    )
    assert review_step(rendered_for(root).text)["with"]["SCOPE"] == value


def test_rendering_is_deterministic_so_an_unchanged_config_writes_nothing(tmp_path):
    assert rendered_for(tmp_path).text == rendered_for(tmp_path).text


def test_rendering_what_was_rendered_changes_nothing_further(tmp_path):
    """The output is a fixed point, so a second run cannot report an endless `update`."""
    first = rendered_for(tmp_path).text
    (tmp_path / ".copirate-review/bases").mkdir(parents=True)
    (tmp_path / f".copirate-review/bases/{SHIPPED_BASE}.yml").write_text(first)
    assert rendered_for(tmp_path).text == first


# --- base resolution --------------------------------------------------------------


def test_a_repo_base_shadows_the_shipped_one_of_the_same_name(tmp_path):
    (tmp_path / ".copirate-review/bases").mkdir(parents=True)
    (tmp_path / f".copirate-review/bases/{SHIPPED_BASE}.yml").write_text(
        "name: Mine\non:\n  push: {}\njobs:\n  review:\n    needs: gate\n    steps:\n"
        "      - id: review\n        uses: nothing@v0\n"
    )
    result = rendered_for(tmp_path)
    assert read_yaml(result.text, "r")[0]["name"] == "Mine"
    assert review_step(result.text)["uses"] == "promptctl/copirate-code-review-agent@v1"
    assert result.base_file.startswith(str(tmp_path))


def test_a_home_base_is_used_when_the_repo_has_none(tmp_path):
    home = machine(tmp_path)
    (home / ".config/copirate-review/bases").mkdir(parents=True)
    (home / f".config/copirate-review/bases/{SHIPPED_BASE}.yml").write_text(
        "name: Fleet\non:\n  push: {}\njobs:\n  review:\n    needs: gate\n    steps:\n"
        "      - id: review\n        uses: nothing@v0\n"
    )
    repo = tmp_path / "repo"
    repo.mkdir()
    assert read_yaml(rendered_for(repo, home=home).text, "r")[0]["name"] == "Fleet"


def test_a_base_whose_review_job_does_not_declare_the_needed_job_is_refused(tmp_path):
    """The shipped inputs read `needs.gate`; a base without that dependency renders a
    workflow GitHub ACCEPTS and then hands the action an empty PR number.

    This is the `pr-review` shape: a repository that overrides nothing but the base name
    inherits the inputs table, so the incoherent combination is the easy one to reach.
    """
    body = (
        "name: X\non:\n  push: {}\njobs:\n  review:\n    steps:\n"
        "      - id: review\n        uses: placeholder@v0\n"
    )
    with pytest.raises(ConfigError) as caught:
        rendered_for(write_base(tmp_path, body))
    message = str(caught.value)
    assert "needs.gate" in message
    assert "no `needs:`" in message
    # It names the input, so the operator knows which line of their config to change.
    assert "PR_NUMBER" in message or "HEAD_SHA" in message


def test_the_same_inputs_are_accepted_once_the_review_job_declares_the_dependency(tmp_path):
    """The refusal is about the DEPENDENCY, not about the inputs — otherwise the check
    would forbid the shipped base's own arrangement."""
    body = (
        "name: X\non:\n  push: {}\njobs:\n  review:\n    needs: [gate, setup]\n    steps:\n"
        "      - id: review\n        uses: placeholder@v0\n"
    )
    step = review_step(rendered_for(write_base(tmp_path, body)).text)
    assert step["uses"] == "promptctl/copirate-code-review-agent@v1"
    assert step["with"]["PR_NUMBER"] == "${{ needs.gate.outputs.pr-number }}"
    assert step["with"]["HEAD_SHA"] == "${{ needs.gate.outputs.head-sha }}"


def test_an_unknown_base_names_every_directory_that_was_searched(tmp_path):
    root = declaring(tmp_path, f"workflows:\n  {WORKFLOW}:\n    base: nowhere\n")
    with pytest.raises(ConfigError) as caught:
        rendered_for(root)
    message = str(caught.value)
    assert "nowhere.yml" in message
    assert ".copirate-review/bases" in message
    assert "shipped with this installer" in message


# --- bases the installer refuses --------------------------------------------------


def write_base(tmp_path, body):
    (tmp_path / ".copirate-review/bases").mkdir(parents=True)
    (tmp_path / f".copirate-review/bases/{SHIPPED_BASE}.yml").write_text(body)
    return tmp_path


def test_a_base_that_is_not_yaml_is_a_config_error_not_a_traceback(tmp_path):
    with pytest.raises(ConfigError, match="not valid YAML"):
        rendered_for(write_base(tmp_path, "name: [unclosed\n"))


def test_a_base_that_is_not_a_workflow_names_the_field_that_is_wrong(tmp_path):
    with pytest.raises(ConfigError) as caught:
        rendered_for(write_base(tmp_path, "name: Only a name\n"))
    assert "on" in str(caught.value)


def test_a_base_with_no_review_step_is_refused_rather_than_shipping_a_reviewer_less_run(
    tmp_path,
):
    """It would be valid YAML, a valid workflow, and review nothing, forever."""
    body = "name: X\non:\n  push: {}\njobs:\n  review:\n    steps:\n      - run: echo hi\n"
    with pytest.raises(ConfigError, match="exactly one step"):
        rendered_for(write_base(tmp_path, body))


def test_a_base_with_two_review_steps_is_refused_rather_than_binding_one_of_them(tmp_path):
    body = (
        "name: X\non:\n  push: {}\njobs:\n  review:\n    steps:\n"
        "      - id: review\n        uses: a@v1\n      - id: review\n        uses: b@v1\n"
    )
    with pytest.raises(ConfigError, match="exactly one step"):
        rendered_for(write_base(tmp_path, body))


def test_a_base_is_bound_wherever_its_review_step_lives(tmp_path):
    """The anchor is the step's id, not its position or the job it is in."""
    body = (
        "name: X\non:\n  push: {}\njobs:\n  lint:\n    steps:\n      - run: echo lint\n"
        "  second:\n    needs: gate\n    steps:\n      - run: echo first\n"
        "      - id: review\n        uses: placeholder@v0\n"
    )
    text = rendered_for(write_base(tmp_path, body)).text
    step = read_yaml(text, "r")[0]["jobs"]["second"]["steps"][1]
    assert step["uses"] == "promptctl/copirate-code-review-agent@v1"
