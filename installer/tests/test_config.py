"""The configuration boundary: what it accepts, what it refuses, and what it produces.

Every test here asserts the contract — which configurations are legal and what a legal
one parses into — never the shape of the code that decides it. [LAW:behavior-not-structure]
"""

from __future__ import annotations

import pytest

from copirate_review.config import (
    Config,
    ConfigError,
    EnvCredential,
    KeychainCredential,
    layer_paths,
    load,
    merge,
    parse,
)

WORKFLOW = ".github/workflows/code-review.yml"

CREDENTIAL = "secrets:\n  CLAUDE_CODE_OAUTH_TOKEN: keychain:ITEM\n"


def machine(tmp_path):
    """A home layer declaring a credential — what every real machine has.

    The shipped layer declares none on purpose, so a load that reaches a `Config` needs
    one somewhere, and the machine layer is where a credential belongs.
    """
    home = tmp_path / "home"
    (home / ".config/copirate-review").mkdir(parents=True, exist_ok=True)
    (home / ".config/copirate-review/config.yaml").write_text(CREDENTIAL)
    return home


def minimal(**overrides) -> dict:
    base = {
        "action_ref": "owner/repo@v1",
        "commit_message": "Converge the workflow",
        "secrets": {"CLAUDE_CODE_OAUTH_TOKEN": "keychain:TOKEN_ITEM"},
        "workflows": {WORKFLOW: {"base": "pr-review"}},
    }
    return {**base, **overrides}


# --- merging ----------------------------------------------------------------------


def test_a_later_layer_overrides_one_input_without_restating_the_others():
    merged = merge(
        minimal(workflows={WORKFLOW: {"base": "pr-review", "inputs": {"A": 1, "B": 2}}}),
        {"workflows": {WORKFLOW: {"inputs": {"B": 9}}}},
    )
    assert merged["workflows"][WORKFLOW]["inputs"] == {"A": 1, "B": 9}
    assert merged["workflows"][WORKFLOW]["base"] == "pr-review"


def test_null_in_a_later_layer_deletes_the_key_it_names():
    merged = merge(minimal(), {"workflows": {WORKFLOW: None}})
    assert merged["workflows"] == {}


def test_a_later_layer_adds_a_second_workflow_beside_the_inherited_one():
    other = ".github/workflows/repo-review.yml"
    merged = merge(minimal(), {"workflows": {other: {"base": "repo-review"}}})
    assert set(merged["workflows"]) == {WORKFLOW, other}


# --- schema refusals --------------------------------------------------------------


@pytest.mark.parametrize(
    "document, expected",
    [
        (minimal(reviewer="someone"), "reviewer"),
        (minimal(secrets={"TOKEN": "vault:TOKEN"}), "TOKEN"),
        (minimal(secrets={"lowercase": "keychain:X"}), "lowercase"),
        (minimal(workflows={WORKFLOW: {"base": "pr-review", "typo": 1}}), "typo"),
        (minimal(workflows={WORKFLOW: {"base": "Not A Name"}}), "base"),
        (minimal(workflows={"elsewhere/review.yml": {"base": "pr-review"}}), "workflows"),
    ],
    ids=["unknown-key", "unknown-scheme", "lowercase-secret", "unknown-workflow-key",
         "bad-base-name", "path-outside-workflows-dir"],
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
        workflows={WORKFLOW: {"base": "pr-review",
                              "inputs": {"CLAUDE_CODE_OAUTH_TOKEN": "x"}}}
    )
    with pytest.raises(ConfigError, match="render the key twice"):
        parse(document, "test.yaml")


# --- what a legal document parses into --------------------------------------------


@pytest.mark.parametrize(
    "declared, expected",
    [
        ("keychain:TOKEN_ITEM", KeychainCredential(item="TOKEN_ITEM")),
        ("env:SOME_TOKEN", EnvCredential(var="SOME_TOKEN")),
    ],
    ids=["keychain", "environment"],
)
def test_a_secret_gets_the_source_its_scheme_names(declared, expected):
    """Which source a secret reads from is a decision the config makes, not the code."""
    config = parse(minimal(secrets={"CLAUDE_CODE_OAUTH_TOKEN": declared}), "test.yaml")
    assert config.secrets == {"CLAUDE_CODE_OAUTH_TOKEN": expected}


def test_one_secret_may_read_the_keychain_while_another_reads_the_environment():
    config = parse(
        minimal(secrets={"FROM_KEYCHAIN": "keychain:ITEM", "FROM_ENV": "env:VAR"}), "test.yaml"
    )
    assert config.secrets == {
        "FROM_KEYCHAIN": KeychainCredential(item="ITEM"),
        "FROM_ENV": EnvCredential(var="VAR"),
    }


def test_an_arbitrary_source_name_fills_an_arbitrary_secret_name():
    """Neither side is derived from the other; a rotation edits one of them."""
    config = parse(minimal(secrets={"REVIEWER_TOKEN": "keychain:acct-b-oauth"}), "test.yaml")
    assert config.secrets["REVIEWER_TOKEN"] == KeychainCredential(item="acct-b-oauth")


def test_a_source_with_no_name_after_the_scheme_is_refused():
    with pytest.raises(ConfigError, match="TOKEN"):
        parse(minimal(secrets={"TOKEN": "keychain:"}), "test.yaml")


@pytest.mark.parametrize(
    "declared, rendered",
    [(True, "true"), (False, "false"), (5, "5"), (2.5, "2.5"), ("already", "already")],
)
def test_every_input_value_reaches_the_renderer_as_the_string_the_action_reads(declared, rendered):
    config = parse(
        minimal(workflows={WORKFLOW: {"base": "pr-review", "inputs": {"SOME_INPUT": declared}}}),
        "test.yaml",
    )
    assert config.workflows[0].inputs["SOME_INPUT"] == rendered


def test_the_paths_the_run_generates_lead_the_exclude_patterns():
    other = ".github/workflows/repo-review.yml"
    config = parse(
        minimal(
            workflows={
                WORKFLOW: {"base": "pr-review", "inputs": {"EXCLUDE_PATTERNS": "dist/**"}},
                other: {"base": "pr-review"},
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


def test_a_repo_that_declares_nothing_inherits_every_layer_above_it(tmp_path):
    home = machine(tmp_path)
    config, layers = load(tmp_path, home)
    assert layers == (home / ".config/copirate-review/config.yaml",)
    assert isinstance(config, Config)
    assert config.workflows[0].path == WORKFLOW


def test_the_shipped_defaults_declare_nobody_credentials():
    """The one layer identical on every machine cannot name one person's keychain item.

    A default here is inherited by every repository that never asked for it and is
    silently wrong for all of them — the secret would be provisioned from an item that
    does not exist, or worse, from one that does and belongs to someone else. Asserted
    against the shipped file, before any layer has had a chance to fill it in.
    """
    from importlib import resources

    from copirate_review import yamldoc

    shipped = resources.files("copirate_review").joinpath("defaults.yaml").read_text()
    assert yamldoc.load(shipped, "defaults")[0]["secrets"] == {}


def test_a_repo_layer_changes_only_what_it_declares(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {WORKFLOW}:\n    inputs:\n      MAX_REVIEW_ROUNDS: 12\n"
    )
    home = machine(tmp_path)
    config, layers = load(tmp_path, home)
    assert layers == (home / ".config/copirate-review/config.yaml", tmp_path / ".copirate-review.yaml")
    inputs = config.workflows[0].inputs
    assert inputs["MAX_REVIEW_ROUNDS"] == "12"
    assert inputs["DEPENDENCY_DIFF"] == "true"  # inherited, not restated
    assert config.action_ref  # inherited


def test_an_empty_config_file_is_the_empty_layer_not_an_error(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text("")
    config, _ = load(tmp_path, machine(tmp_path))
    assert config.workflows[0].base == "pr-review"


def test_a_config_file_that_is_not_a_mapping_is_refused(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text("- a list\n")
    with pytest.raises(ConfigError, match="expected a mapping"):
        load(tmp_path, tmp_path / "absent-home")


def test_a_workflow_with_no_base_anywhere_in_the_layers_is_refused():
    with pytest.raises(ConfigError, match="has no base"):
        parse(minimal(workflows={WORKFLOW: {"inputs": {"A": 1}}}), "test.yaml")


def test_a_null_input_in_a_later_layer_drops_it_from_the_rendered_step(tmp_path):
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {WORKFLOW}:\n    inputs:\n      DEPENDENCY_DIFF: null\n"
    )
    config, _ = load(tmp_path, machine(tmp_path))
    assert "DEPENDENCY_DIFF" not in config.workflows[0].inputs


def test_a_null_survives_into_no_layer_even_where_the_one_below_declared_nothing(tmp_path):
    """The null rule holds at every depth, not only where both layers happen to agree."""
    other = ".github/workflows/repo-review.yml"
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {other}:\n    base: pr-review\n"
        f"    inputs:\n      MAX_REVIEW_ROUNDS: null\n"
    )
    config, _ = load(tmp_path, machine(tmp_path))
    added = next(w for w in config.workflows if w.path == other)
    assert "MAX_REVIEW_ROUNDS" not in added.inputs


def test_the_one_input_a_null_may_not_delete_is_refused_rather_than_half_honoured(tmp_path):
    """`EXCLUDE_PATTERNS: null` cannot mean what a null means everywhere else.

    The installer always prepends the paths it generates, so the key is always
    rendered — and action.yml REPLACES its own default with whatever it receives. A
    null therefore did not fall back to that default; it rendered a live key carrying
    only the generated paths, silently readmitting `dist/**` and every lock file to
    review. That is the ~700K-token no-signal read `defaults.yaml` exists to prevent,
    arriving as a config that looked like it was asking for less. [LAW:no-silent-failure]
    """
    (tmp_path / ".copirate-review.yaml").write_text(
        f"workflows:\n  {WORKFLOW}:\n    inputs:\n      EXCLUDE_PATTERNS: null\n"
    )
    with pytest.raises(ConfigError, match="EXCLUDE_PATTERNS"):
        load(tmp_path, machine(tmp_path))


def test_excluding_nothing_but_the_generated_paths_is_still_expressible(tmp_path):
    """The state the null used to produce by accident, asked for on purpose."""
    (tmp_path / ".copirate-review.yaml").write_text(
        f'workflows:\n  {WORKFLOW}:\n    inputs:\n      EXCLUDE_PATTERNS: ""\n'
    )
    config, _ = load(tmp_path, machine(tmp_path))
    assert config.workflows[0].inputs["EXCLUDE_PATTERNS"] == WORKFLOW


def test_a_secret_colliding_with_the_injected_exclude_input_is_refused():
    """The guard sees what will be RENDERED, not only what was declared."""
    with pytest.raises(ConfigError, match="render the key twice"):
        parse(
            {
                "action_ref": "owner/repo@v1",
                "commit_message": "m",
                "secrets": {"EXCLUDE_PATTERNS": "keychain:X"},
                "workflows": {WORKFLOW: {"base": "pr-review"}},
            },
            "test.yaml",
        )


def test_declaring_no_credentials_is_refused_rather_than_wiring_a_reviewer_to_nothing():
    """It would install cleanly and fail on the first pull request.

    The shipped layer names no credential on purpose, so this is the state a brand-new
    repository starts in — which makes a loud refusal, naming both schemes and both
    places to declare one, the difference between a working install and a dead reviewer
    nobody can account for. [LAW:no-silent-failure]
    """
    with pytest.raises(ConfigError) as caught:
        parse(minimal(secrets={}), "test.yaml")
    message = str(caught.value)
    assert "keychain:" in message and "env:" in message
    assert ".copirate-review.yaml" in message


def test_a_repo_with_no_configuration_at_all_is_told_what_it_is_missing(tmp_path):
    """The state a brand-new repository starts in, now that nothing ships a credential."""
    with pytest.raises(ConfigError, match="no credentials are declared"):
        load(tmp_path, tmp_path / "absent-home")
