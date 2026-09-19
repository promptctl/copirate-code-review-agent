"""Turn the configuration layers on disk into one `Config` that cannot be invalid.

This module is the installer's border checkpoint. Everything downstream — the
renderer, the planner, the effects — takes a `Config` and never re-asks whether a
template name is well-formed, whether a credential source is supported, or whether
an input value is a string, because a `Config` carrying any of those could not have
been built. [LAW:parse-dont-validate]
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

import yaml
from jsonschema import Draft202012Validator

#: Repo-relative paths the repository's own layer may live at, in precedence order.
#: Both existing is fatal rather than first-wins — two files claiming to configure one
#: repo is the two-clocks state, and picking one silently makes the other's edits
#: vanish with nothing to say so. [LAW:one-source-of-truth]
REPO_CONFIG_PATHS = (".copirate-review.yaml", ".copirate-review/config.yaml")

#: The user-global layer, between the shipped defaults and the repo's own file. This is
#: where fleet policy lives: the credential table and the action ref, declared once for
#: every repo on this machine instead of copied into each.
HOME_CONFIG_PATH = ".config/copirate-review/config.yaml"

#: Directory name holding a repo's own templates, beside its config.
REPO_TEMPLATE_DIR = ".copirate-review/templates"
HOME_TEMPLATE_DIR = ".config/copirate-review/templates"

#: The one input whose rendered value the installer composes rather than passes through.
#: See `_with_generated_excluded`.
EXCLUDE_INPUT = "EXCLUDE_PATTERNS"

KEYCHAIN_SCHEME = "keychain:"

#: Keys the MERGED document must carry. Deliberately NOT in schema.json's own
#: `required`, because that is checked against each LAYER and a layer is a patch — a
#: repo overriding one input must not have to restate the action ref it inherits.
#: Completeness is a property of the whole, so it is asserted once, against the whole.
#: [LAW:single-enforcer]
REQUIRED = ("action_ref", "commit_message", "secrets", "workflows")


class ConfigError(Exception):
    """A configuration the installer refuses to act on, with the file named."""


@dataclass(frozen=True)
class KeychainCredential:
    """A macOS keychain generic-password item, named by its service.

    The item is the whole source. There is no fallback to the secret's own name and no
    ambient override: a wrong declaration must surface as a missing item, never resolve
    silently to whatever else is filed nearby. [LAW:no-silent-failure]
    """

    item: str


@dataclass(frozen=True)
class WorkflowSpec:
    """One workflow file to converge: where it goes, what shape it takes, what it binds.

    `inputs` is already normalized to the strings the renderer will quote — the renderer
    receives no booleans, no integers, and no absent keys to defend against.
    """

    path: str
    template: str
    inputs: Mapping[str, str]


@dataclass(frozen=True)
class Config:
    """The merged, validated configuration. Every field is present and well-formed."""

    action_ref: str
    commit_message: str
    secrets: Mapping[str, KeychainCredential]
    workflows: tuple[WorkflowSpec, ...]


def _schema() -> dict[str, Any]:
    return json.loads(resources.files(__package__).joinpath("schema.json").read_text())


def _read_layer(path: Path) -> dict[str, Any]:
    """Read one YAML layer, rejecting anything that is not a mapping.

    An empty file is the empty mapping — a repo that creates the file and declares
    nothing is a real, ordinary state, not an error. [LAW:dataflow-not-control-flow]
    """
    try:
        loaded = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path}: not valid YAML — {exc}") from exc
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise ConfigError(f"{path}: expected a mapping at the top level, got {type(loaded).__name__}.")
    return loaded


def _validate(doc: Mapping[str, Any], source: str, *, required: tuple[str, ...] = ()) -> None:
    """Check a document against the schema, reporting every violation at once.

    Every error is reported rather than the first, because the operator's next act is to
    open the file and fix it — handing back one of four typos costs four round trips.
    An unknown key is among the violations: a silently ignored typo leaves a repo paying
    for reviews it meant to stop paying for, with nothing anywhere to say so.
    [LAW:no-silent-failure]
    """
    schema = {**_schema(), "required": list(required)} if required else _schema()
    errors = sorted(Draft202012Validator(schema).iter_errors(doc), key=lambda e: list(e.path))
    if not errors:
        return
    detail = "\n".join(
        f"  {'.'.join(str(p) for p in e.path) or '(root)'}: {e.message}" for e in errors
    )
    raise ConfigError(f"{source}: invalid configuration —\n{detail}")


def merge(base: Mapping[str, Any], over: Mapping[str, Any]) -> dict[str, Any]:
    """Deep-merge one layer over another; a null in the upper layer deletes the key.

    One rule for every key, at every depth. The alternative — a per-key merge table
    saying which lists append and which replace — is a second map of the schema, free to
    disagree with it the first time a key is added. Deletion-by-null is what lets a repo
    opt out of an inherited workflow or secret without the schema growing an `enabled:`
    flag for every entry. [LAW:dataflow-not-control-flow] [LAW:no-mode-explosion]
    """
    merged = dict(base)
    for key, value in over.items():
        if value is None:
            merged.pop(key, None)
        elif isinstance(value, dict):
            # Recursed into unconditionally, against an empty mapping when the lower
            # layer has nothing here. Recursing only where BOTH layers happen to hold a
            # dict makes the null rule depend on a structural accident — a null inside a
            # workflow the lower layer never declared would survive, and render as the
            # literal string "None" into a consumer's workflow. One rule, at every depth.
            below = merged[key] if isinstance(merged.get(key), dict) else {}
            merged[key] = merge(below, value)
        else:
            merged[key] = value
    return merged


def _credential(source_uri: str, secret_name: str) -> KeychainCredential:
    """Parse a credential source into the one kind of source there is.

    The scheme is the seam a second kind would arrive through, so the error names the
    supported set rather than saying the value is malformed. [LAW:parse-dont-validate]
    """
    if not source_uri.startswith(KEYCHAIN_SCHEME):
        raise ConfigError(
            f"secrets.{secret_name}: unsupported credential source {source_uri!r}. "
            f"Supported schemes: {KEYCHAIN_SCHEME}<item>."
        )
    return KeychainCredential(item=source_uri[len(KEYCHAIN_SCHEME) :])


def _render_value(value: str | int | float | bool) -> str:
    """Normalize an input value to the string the workflow will carry.

    A YAML `true` and the string `"true"` mean the same thing to `action.yml`, which
    reads every input as a string — so both arrive here and leave identical, and the
    renderer downstream handles one type. Python's `True` would render as `True`, which
    the action does not recognize. [LAW:parse-dont-validate]
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _with_generated_excluded(inputs: dict[str, str], generated: tuple[str, ...]) -> dict[str, str]:
    """Prepend the paths this installer generates to the review's exclude patterns.

    Every workflow the installer writes is a derived copy of a template: a finding
    against one targets the copy, not its source, and any fix would be silently reverted
    by the next install. So they are withheld from review — uniformly, for every path
    the run generates, which is why no workflow path is repeated in `defaults.yaml`.
    [LAW:one-source-of-truth]

    The exclusion lives in the input rather than in a trigger-level `paths-ignore`:
    skipping the whole run would leave a head SHA with no review, which downstream
    tooling reads as a broken reviewer, not as a deliberate withholding.
    """
    declared = inputs.get(EXCLUDE_INPUT, "")
    patterns = [*generated, *(p for p in declared.split(",") if p)]
    return {**inputs, EXCLUDE_INPUT: ",".join(patterns)}


def parse(merged: Mapping[str, Any], source: str) -> Config:
    """The checkpoint: a merged document in, a `Config` out, or a loud refusal.

    Returns a type that could not have existed before the check ran, so nothing
    downstream re-inspects any of it. [LAW:parse-dont-validate]
    """
    # The merged document is checked with `required` on, which is the one place it
    # means anything. Every layer was already checked without it on the way in, so a
    # missing key here can only mean the shipped defaults are incomplete — an assertion
    # the schema now carries rather than a hand-written guard whose message had to guess
    # at a cause. [LAW:polishing-by-subtraction]
    _validate(merged, source, required=REQUIRED)

    secrets = {name: _credential(uri, name) for name, uri in merged["secrets"].items()}

    raw_workflows: Mapping[str, Any] = merged["workflows"]
    if not raw_workflows:
        raise ConfigError(
            f"{source}: 'workflows' is empty — there is nothing to install. Declare one, "
            f"or stop running the installer in this repo."
        )
    generated = tuple(sorted(raw_workflows))

    workflows = []
    for path in generated:
        spec = raw_workflows[path]
        # Required of the MERGED document, not of each layer. A layer is a PATCH — a repo
        # overriding one input must not have to restate the template it inherits — so the
        # schema cannot carry this and the check lives at the one place holding the whole
        # document. [LAW:single-enforcer]
        if "template" not in spec:
            raise ConfigError(
                f"{source}: workflows.{path} has no template. Every workflow names the "
                f"template it renders from; add `template: <name>`."
            )
        # Composed BEFORE the collision check, because the check has to see what will
        # actually be rendered. Checking the declared inputs alone lets an injected name
        # collide unnoticed. [LAW:no-silent-failure]
        inputs = _with_generated_excluded(
            {name: _render_value(value) for name, value in (spec.get("inputs") or {}).items()},
            generated,
        )
        # A name in both tables would render the `with:` key twice, and YAML's last-wins
        # would pick one with nothing to say which. Refuse the shape instead of resolving
        # it. [LAW:no-silent-failure]
        collisions = sorted(set(inputs) & set(secrets))
        if collisions:
            raise ConfigError(
                f"{source}: workflows.{path}.inputs declares {', '.join(collisions)}, "
                f"which is already a secret — every secret is wired into `with:` under "
                f"its own name, so this would render the key twice. Remove one."
            )
        workflows.append(
            WorkflowSpec(
                path=path,
                template=spec["template"],
                inputs=inputs,
            )
        )

    return Config(
        action_ref=merged["action_ref"],
        commit_message=merged["commit_message"],
        secrets=secrets,
        workflows=tuple(workflows),
    )


def layer_paths(repo_root: Path, home: Path) -> tuple[Path, ...]:
    """The configuration files that exist, lowest layer first.

    The shipped defaults are not here: they are packaged data, not a path on this
    machine, and they are always present.
    """
    found: list[Path] = []
    home_config = home / HOME_CONFIG_PATH
    if home_config.is_file():
        found.append(home_config)

    repo_configs = [repo_root / name for name in REPO_CONFIG_PATHS if (repo_root / name).is_file()]
    if len(repo_configs) > 1:
        raise ConfigError(
            "two repository configuration files exist: "
            + ", ".join(str(p) for p in repo_configs)
            + ". One repo, one config — delete the one you do not mean."
        )
    found.extend(repo_configs)
    return tuple(found)


def load(repo_root: Path, home: Path) -> tuple[Config, tuple[Path, ...]]:
    """Read every layer, merge them, and parse the result. Returns the layers it used."""
    defaults_text = resources.files(__package__).joinpath("defaults.yaml").read_text()
    merged: dict[str, Any] = yaml.safe_load(defaults_text)

    paths = layer_paths(repo_root, home)
    for path in paths:
        layer = _read_layer(path)
        _validate(layer, str(path))
        merged = merge(merged, layer)

    source = str(paths[-1]) if paths else "the shipped defaults"
    return parse(merged, source), paths
