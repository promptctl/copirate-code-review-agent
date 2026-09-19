"""Resolve a template by name and render one workflow's desired text.

Rendering is pure: text in, text out, no repository touched. The caller compares the
result against what is deployed and performs only the writes the difference demands.
[LAW:effects-at-boundaries]
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from jinja2 import ChoiceLoader, Environment, FileSystemLoader, PackageLoader, StrictUndefined
from jinja2 import TemplateNotFound

from .config import HOME_TEMPLATE_DIR, REPO_TEMPLATE_DIR, Config, ConfigError, WorkflowSpec

TEMPLATE_SUFFIX = ".yml.j2"


@dataclass(frozen=True)
class Rendered:
    """One workflow's desired text, and the template file that produced it."""

    path: str
    text: str
    template_file: str


def _environment(repo_root: Path, home: Path) -> Environment:
    """A Jinja environment whose delimiters cannot collide with GitHub Actions'.

    `${{ secrets.X }}` contains `{{ ... }}`, so under Jinja's defaults every Actions
    expression in a template would be evaluated as a Jinja variable and render empty.
    Moving Jinja to `<< >>` lets a template be read and edited as the GitHub Actions
    YAML it is, with no escaping ritual anywhere in it — the alternative pushes an
    obligation onto every line of every template a consumer ever writes.

    `StrictUndefined` makes a variable the template asks for and the config does not
    supply a loud error. The default would render it as empty string, shipping a
    workflow with a blank `uses:` into a consuming repo. [LAW:no-silent-failure]
    """
    return Environment(
        loader=ChoiceLoader(
            [
                FileSystemLoader([repo_root / REPO_TEMPLATE_DIR, home / HOME_TEMPLATE_DIR]),
                PackageLoader(__package__, "templates"),
            ]
        ),
        variable_start_string="<<",
        variable_end_string=">>",
        block_start_string="<%",
        block_end_string="%>",
        comment_start_string="<#",
        comment_end_string="#>",
        undefined=StrictUndefined,
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def _yaml_quote(value: str) -> str:
    """Quote a value as a YAML double-quoted scalar.

    Every JSON string is a valid YAML double-quoted scalar, so `json.dumps` is the whole
    encoder — and the one that cannot be talked out of escaping a quote or a backslash.
    Substituting a value raw is how a config that happens to contain `"` silently
    corrupts a rendered workflow instead of failing. [LAW:parse-dont-validate]
    """
    return json.dumps(value)


def resolve_action_ref(config: Config, repo: str) -> str:
    """The `uses:` ref for this repo — `./` in the action's own source repository.

    The action's source repo must review each PR with THAT PR's code, which is the one
    thing a released `@v1` cannot do for it: a change to the reviewer that no run ever
    executed is a change the repo ships untested.

    This is the whole accommodation, and its shape is the point — it selects a VALUE and
    nothing else, so the same template converges here as everywhere and every future
    template change reaches this repo like any other consumer. An exemption that skipped
    convergence instead is precisely how a deployed workflow and its template drift into
    two representations of one thing: an operation that does not run cannot receive a
    change. [LAW:dataflow-not-control-flow]

    The discriminator derives from `action_ref`, so "which repo is the action" is not a
    second copy free to drift from it. [LAW:one-source-of-truth]
    """
    return "./" if repo == config.action_ref.split("@")[0] else config.action_ref


def render(config: Config, spec: WorkflowSpec, action_ref: str, repo_root: Path, home: Path) -> Rendered:
    env = _environment(repo_root, home)
    env.filters["yaml_quote"] = _yaml_quote
    name = spec.template + TEMPLATE_SUFFIX
    try:
        template = env.get_template(name)
    except TemplateNotFound as exc:
        searched = ", ".join(
            str(d) for d in (repo_root / REPO_TEMPLATE_DIR, home / HOME_TEMPLATE_DIR)
        )
        raise ConfigError(
            f"workflows.{spec.path}: no template named {spec.template!r}. Looked for "
            f"{name} in {searched}, and in the templates shipped with this installer."
        ) from exc

    text = template.render(
        action_ref=action_ref,
        workflow_path=spec.path,
        template_name=spec.template,
        inputs=dict(spec.inputs),
        secrets=sorted(config.secrets),
    )
    return Rendered(path=spec.path, text=text, template_file=template.filename or name)
