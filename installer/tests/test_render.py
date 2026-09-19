"""Template resolution and rendering: what lands in a consumer's workflow file."""

from __future__ import annotations

import pytest
import yaml

from copirate_review.config import ConfigError, load, parse
from copirate_review.render import render, resolve_action_ref

from .test_config import WORKFLOW, minimal


def rendered_for(tmp_path, repo="someone/else", home=None):
    config, _ = load(tmp_path, home or tmp_path / "absent-home")
    action_ref = resolve_action_ref(config, repo)
    return render(config, config.workflows[0], action_ref, tmp_path, home or tmp_path / "absent-home")


# --- the action ref ---------------------------------------------------------------


def test_a_consumer_gets_the_moving_major_tag():
    config = parse(minimal(action_ref="promptctl/copirate-code-review-agent@v1"), "t.yaml")
    assert resolve_action_ref(config, "someone/else") == "promptctl/copirate-code-review-agent@v1"


def test_the_actions_own_repo_reviews_each_pr_with_that_prs_code():
    config = parse(minimal(action_ref="promptctl/copirate-code-review-agent@v1"), "t.yaml")
    assert resolve_action_ref(config, "promptctl/copirate-code-review-agent") == "./"


# --- what the rendered workflow contains ------------------------------------------


def test_the_rendered_workflow_is_valid_yaml_carrying_the_declared_bindings(tmp_path):
    result = rendered_for(tmp_path)
    workflow = yaml.safe_load(result.text)
    step = next(s for s in workflow["jobs"]["review"]["steps"] if s.get("id") == "review")
    assert step["uses"] == "promptctl/copirate-code-review-agent@v1"
    assert step["with"]["CLAUDE_CODE_OAUTH_TOKEN"] == "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"
    assert step["with"]["MAX_REVIEW_ROUNDS"] == "5"


def test_every_declared_secret_is_wired_into_the_step_under_its_own_name(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text("secrets:\n  OPENAI_API_KEY: keychain:OAI\n")
    result = rendered_for(tmp_path)
    step = next(
        s for s in yaml.safe_load(result.text)["jobs"]["review"]["steps"] if s.get("id") == "review"
    )
    assert step["with"]["OPENAI_API_KEY"] == "${{ secrets.OPENAI_API_KEY }}"
    assert step["with"]["CLAUDE_CODE_OAUTH_TOKEN"] == "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"


def test_a_deleted_secret_is_neither_provisioned_nor_wired(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        "secrets:\n  CLAUDE_CODE_OAUTH_TOKEN: null\n  ZAI_API_KEY: keychain:ZAI\n"
    )
    result = rendered_for(tmp_path)
    step = next(
        s for s in yaml.safe_load(result.text)["jobs"]["review"]["steps"] if s.get("id") == "review"
    )
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in step["with"]
    assert step["with"]["ZAI_API_KEY"] == "${{ secrets.ZAI_API_KEY }}"


def test_actions_expressions_survive_rendering_untouched(tmp_path):
    """Jinja's own delimiters would eat `${{ ... }}`; the template's must not collide."""
    text = rendered_for(tmp_path).text
    assert "${{ github.event.pull_request.head.sha }}" in text
    assert "${{ steps.review.outputs.transcript-dir }}" in text


def test_a_value_carrying_a_quote_is_escaped_rather_than_corrupting_the_yaml(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        f'workflows:\n  {WORKFLOW}:\n    inputs:\n      SCOPE: \'say "hi" \\ bye\'\n'
    )
    step = next(
        s
        for s in yaml.safe_load(rendered_for(tmp_path).text)["jobs"]["review"]["steps"]
        if s.get("id") == "review"
    )
    assert step["with"]["SCOPE"] == 'say "hi" \\ bye'


def test_rendering_is_deterministic_so_an_unchanged_config_writes_nothing(tmp_path):
    assert rendered_for(tmp_path).text == rendered_for(tmp_path).text


# --- template resolution ----------------------------------------------------------


def test_a_repo_template_shadows_the_shipped_one_of_the_same_name(tmp_path):
    (tmp_path / ".copirate-review/templates").mkdir(parents=True)
    (tmp_path / ".copirate-review/templates/pr-review.yml.j2").write_text(
        "name: Mine\nuses: <<action_ref>>\n"
    )
    result = rendered_for(tmp_path)
    assert result.text == "name: Mine\nuses: promptctl/copirate-code-review-agent@v1\n"
    assert result.template_file.startswith(str(tmp_path))


def test_a_home_template_is_used_when_the_repo_has_none(tmp_path):
    home = tmp_path / "home"
    (home / ".config/copirate-review/templates").mkdir(parents=True)
    (home / ".config/copirate-review/templates/pr-review.yml.j2").write_text("name: Fleet\n")
    repo = tmp_path / "repo"
    repo.mkdir()
    assert rendered_for(repo, home=home).text == "name: Fleet\n"


def test_an_unknown_template_names_every_directory_that_was_searched(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {WORKFLOW}:\n    template: nowhere\n"
    )
    with pytest.raises(ConfigError) as caught:
        rendered_for(tmp_path)
    message = str(caught.value)
    assert "nowhere.yml.j2" in message
    assert ".copirate-review/templates" in message
    assert "shipped with this installer" in message


def test_a_template_asking_for_a_variable_that_does_not_exist_fails_loudly(tmp_path):
    (tmp_path / ".copirate-review/templates").mkdir(parents=True)
    (tmp_path / ".copirate-review/templates/pr-review.yml.j2").write_text("<<no_such_thing>>")
    with pytest.raises(ConfigError, match="no_such_thing"):
        rendered_for(tmp_path)


def test_a_template_with_a_syntax_error_is_a_config_error_not_a_traceback(tmp_path):
    (tmp_path / ".copirate-review/templates").mkdir(parents=True)
    (tmp_path / ".copirate-review/templates/pr-review.yml.j2").write_text("<% for x in %>")
    with pytest.raises(ConfigError, match="could not render"):
        rendered_for(tmp_path)


def test_the_self_review_discriminator_ignores_case_as_github_itself_does():
    """gh reports the canonical casing; `action_ref` carries whatever a human typed.

    An exact comparison misses, and the miss is silent: the action's own repo would
    review its pull requests with the RELEASED ref instead of the code under review.
    """
    config = parse(minimal(action_ref="PromptCtl/CoPirate-Code-Review-Agent@v1"), "t.yaml")
    assert resolve_action_ref(config, "promptctl/copirate-code-review-agent") == "./"
