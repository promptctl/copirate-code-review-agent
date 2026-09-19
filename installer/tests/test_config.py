"""The configuration boundary: what it accepts, what it refuses, and what it produces.

Every test here asserts the contract — which configurations are legal and what a legal
one parses into — never the shape of the code that decides it. [LAW:behavior-not-structure]
"""

from __future__ import annotations

import pytest

from copirate_review.config import (
    Config,
    ConfigError,
    KeychainCredential,
    layer_paths,
    load,
    merge,
    parse,
)

WORKFLOW = ".github/workflows/code-review.yml"


def minimal(**overrides) -> dict:
    base = {
        "action_ref": "owner/repo@v1",
        "commit_message": "Converge the workflow",
        "secrets": {"CLAUDE_CODE_OAUTH_TOKEN": "keychain:TOKEN_ITEM"},
        "workflows": {WORKFLOW: {"template": "pr-review"}},
    }
    return {**base, **overrides}


# --- merging ----------------------------------------------------------------------


def test_a_later_layer_overrides_one_input_without_restating_the_others():
    merged = merge(
        minimal(workflows={WORKFLOW: {"template": "pr-review", "inputs": {"A": 1, "B": 2}}}),
        {"workflows": {WORKFLOW: {"inputs": {"B": 9}}}},
    )
    assert merged["workflows"][WORKFLOW]["inputs"] == {"A": 1, "B": 9}
    assert merged["workflows"][WORKFLOW]["template"] == "pr-review"


def test_null_in_a_later_layer_deletes_the_key_it_names():
    merged = merge(minimal(), {"workflows": {WORKFLOW: None}})
    assert merged["workflows"] == {}


def test_a_later_layer_adds_a_second_workflow_beside_the_inherited_one():
    other = ".github/workflows/repo-review.yml"
    merged = merge(minimal(), {"workflows": {other: {"template": "repo-review"}}})
    assert set(merged["workflows"]) == {WORKFLOW, other}


# --- schema refusals --------------------------------------------------------------


@pytest.mark.parametrize(
    "document, expected",
    [
        (minimal(reviewer="someone"), "reviewer"),
        (minimal(secrets={"TOKEN": "env:TOKEN"}), "TOKEN"),
        (minimal(secrets={"lowercase": "keychain:X"}), "lowercase"),
        (minimal(workflows={WORKFLOW: {"template": "pr-review", "typo": 1}}), "typo"),
        (minimal(workflows={WORKFLOW: {"template": "Not A Name"}}), "template"),
        (minimal(workflows={"elsewhere/review.yml": {"template": "pr-review"}}), "workflows"),
    ],
    ids=["unknown-key", "unknown-scheme", "lowercase-secret", "unknown-workflow-key",
         "bad-template-name", "path-outside-workflows-dir"],
)
def test_an_invalid_document_is_refused_naming_what_is_wrong(document, expected):
    with pytest.raises(ConfigError) as caught:
        parse(document, "test.yaml")
    assert expected in str(caught.value)


def test_a_deleted_required_key_is_refused_rather_than_defaulted():
    document = minimal()
    del document["action_ref"]
    with pytest.raises(ConfigError, match="action_ref"):
        parse(document, "test.yaml")


def test_declaring_no_workflows_is_refused_rather_than_silently_installing_nothing():
    with pytest.raises(ConfigError, match="nothing to install"):
        parse(minimal(workflows={}), "test.yaml")


def test_an_input_that_repeats_a_secret_name_is_refused():
    document = minimal(
        workflows={WORKFLOW: {"template": "pr-review",
                              "inputs": {"CLAUDE_CODE_OAUTH_TOKEN": "x"}}}
    )
    with pytest.raises(ConfigError, match="render the key twice"):
        parse(document, "test.yaml")


# --- what a legal document parses into --------------------------------------------


def test_parsing_yields_a_credential_stripped_of_its_scheme():
    config = parse(minimal(), "test.yaml")
    assert config.secrets == {"CLAUDE_CODE_OAUTH_TOKEN": KeychainCredential(item="TOKEN_ITEM")}


@pytest.mark.parametrize(
    "declared, rendered",
    [(True, "true"), (False, "false"), (5, "5"), (2.5, "2.5"), ("already", "already")],
)
def test_every_input_value_reaches_the_renderer_as_the_string_the_action_reads(declared, rendered):
    config = parse(
        minimal(workflows={WORKFLOW: {"template": "pr-review", "inputs": {"SOME_INPUT": declared}}}),
        "test.yaml",
    )
    assert config.workflows[0].inputs["SOME_INPUT"] == rendered


def test_the_paths_the_run_generates_lead_the_exclude_patterns():
    other = ".github/workflows/repo-review.yml"
    config = parse(
        minimal(
            workflows={
                WORKFLOW: {"template": "pr-review", "inputs": {"EXCLUDE_PATTERNS": "dist/**"}},
                other: {"template": "pr-review"},
            }
        ),
        "test.yaml",
    )
    by_path = {w.path: w for w in config.workflows}
    assert by_path[WORKFLOW].inputs["EXCLUDE_PATTERNS"] == f"{WORKFLOW},{other},dist/**"
    # A workflow that declares none still withholds the generated files from review.
    assert by_path[other].inputs["EXCLUDE_PATTERNS"] == f"{WORKFLOW},{other}"


# --- layer discovery --------------------------------------------------------------


def test_two_repository_config_files_are_refused_rather_than_one_silently_winning(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text("{}")
    (tmp_path / ".copirate-review").mkdir()
    (tmp_path / ".copirate-review/config.yaml").write_text("{}")
    with pytest.raises(ConfigError, match="One repo, one config"):
        layer_paths(tmp_path, tmp_path / "home")


def test_layers_are_ordered_home_first_so_the_repo_has_the_last_word(tmp_path):
    home = tmp_path / "home"
    (home / ".config/copirate-review").mkdir(parents=True)
    (home / ".config/copirate-review/config.yaml").write_text("{}")
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".copirate-review.yaml").write_text("{}")
    assert layer_paths(repo, home) == (
        home / ".config/copirate-review/config.yaml",
        repo / ".copirate-review.yaml",
    )


def test_a_repo_that_declares_nothing_loads_the_shipped_defaults(tmp_path):
    config, layers = load(tmp_path, tmp_path / "absent-home")
    assert layers == ()
    assert isinstance(config, Config)
    assert config.workflows[0].path == WORKFLOW


def test_a_repo_layer_changes_only_what_it_declares(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {WORKFLOW}:\n    inputs:\n      MAX_REVIEW_ROUNDS: 12\n"
    )
    config, layers = load(tmp_path, tmp_path / "absent-home")
    assert layers == (tmp_path / ".copirate-review.yaml",)
    inputs = config.workflows[0].inputs
    assert inputs["MAX_REVIEW_ROUNDS"] == "12"
    assert inputs["DEPENDENCY_DIFF"] == "true"  # inherited, not restated
    assert config.secrets["CLAUDE_CODE_OAUTH_TOKEN"].item  # inherited


def test_an_empty_config_file_is_the_empty_layer_not_an_error(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text("")
    config, _ = load(tmp_path, tmp_path / "absent-home")
    assert config.workflows[0].template == "pr-review"


def test_a_config_file_that_is_not_a_mapping_is_refused(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text("- a list\n")
    with pytest.raises(ConfigError, match="expected a mapping"):
        load(tmp_path, tmp_path / "absent-home")


def test_a_workflow_with_no_template_anywhere_in_the_layers_is_refused():
    with pytest.raises(ConfigError, match="has no template"):
        parse(minimal(workflows={WORKFLOW: {"inputs": {"A": 1}}}), "test.yaml")


def test_a_null_input_in_a_later_layer_drops_it_from_the_rendered_step(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {WORKFLOW}:\n    inputs:\n      DEPENDENCY_DIFF: null\n"
    )
    config, _ = load(tmp_path, tmp_path / "absent-home")
    assert "DEPENDENCY_DIFF" not in config.workflows[0].inputs


def test_a_null_survives_into_no_layer_even_where_the_one_below_declared_nothing(tmp_path):
    """The null rule holds at every depth, not only where both layers happen to agree."""
    other = ".github/workflows/repo-review.yml"
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {other}:\n    template: pr-review\n"
        f"    inputs:\n      MAX_REVIEW_ROUNDS: null\n"
    )
    config, _ = load(tmp_path, tmp_path / "absent-home")
    added = next(w for w in config.workflows if w.path == other)
    assert "MAX_REVIEW_ROUNDS" not in added.inputs


def test_a_secret_colliding_with_the_injected_exclude_input_is_refused():
    """The guard sees what will be RENDERED, not only what was declared."""
    with pytest.raises(ConfigError, match="render the key twice"):
        parse(
            {
                "action_ref": "owner/repo@v1",
                "commit_message": "m",
                "secrets": {"EXCLUDE_PATTERNS": "keychain:X"},
                "workflows": {WORKFLOW: {"template": "pr-review"}},
            },
            "test.yaml",
        )
