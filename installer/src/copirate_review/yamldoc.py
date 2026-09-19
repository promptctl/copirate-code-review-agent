"""Read and write YAML documents without discarding their comments.

A YAML comment is content. The base workflow this installer renders from carries the
reason `persist-credentials` is off on an untrusted checkout, and the reason the
trigger is `pull_request` and not `pull_request_target` — the kind of thing a reader
of a generated workflow most needs and can least reconstruct. A loader that parses to
plain data and an emitter that writes plain data back delete every line of it while
every test still passes, which is why this module exists at all.
[LAW:no-silent-failure]

The split is deliberate: this module knows YAML and knows nothing about workflows,
and `workflow.py` knows workflows and no YAML. [LAW:decomposition] [LAW:one-way-deps]

Comments are captured EXACTLY where ruamel puts them, as data, and restored to the
same places. That is not the obvious design — the obvious one re-homes each comment
onto the key it visually precedes — but ruamel attaches trivia to the node BEFORE it,
so the obvious design is a reinterpretation, and a reinterpretation can be wrong.
This one is checked instead: `emit(load(text)) == text` for the shipped base.
[FRAMING:representation]
"""

from __future__ import annotations

import io
from typing import Any

from pydantic import BaseModel
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import DoubleQuotedScalarString
from ruamel.yaml.error import CommentMark
from ruamel.yaml.tokens import CommentToken

#: ruamel keeps four trivia slots per key. Slots 0 and 2 hold ONE token; 1 and 3 hold a
#: list of them. Restoring a list where a token belongs emits nothing at all, silently,
#: so the shape is named once here rather than guessed at the two call sites.
SINGLE_TOKEN_SLOTS = (0, 2)

#: Where a node's own leading comment lives: `ca.comment[1]`. `[0]` is unused by the
#: round-trip parser for the documents this reads.
NODE_COMMENT_SLOT = 1

Key = str | int
NodePath = tuple[Key, ...]


class CommentSpec(BaseModel):
    """One comment token: its text, and the column it starts at.

    The column is carried because it is what makes a trailing `# v7.0.1` stay on its
    own line's end rather than migrating to column zero. It is a property of the
    comment, not of the node, so it travels with it.
    """

    model_config = {"frozen": True}

    text: str
    column: int


class Trivia(BaseModel):
    """Every comment attached at one place in the document.

    `key` names what inside `path`'s node the comments hang off: a mapping key, a
    sequence index, or `None` for the node's own leading block.
    """

    model_config = {"frozen": True}

    path: NodePath
    key: Key | None
    slot: int
    comments: tuple[CommentSpec, ...]


class YamlError(Exception):
    """A document that is not YAML at all, with the source named."""


def _yaml() -> YAML:
    """The one reader/writer, configured once.

    `indent(sequence=4, offset=2)` is what makes a list item's dash align under its
    parent key the way every GitHub Actions workflow in the world is written. ruamel's
    default re-indents the whole `steps:` block on the first render, which would show
    up as a diff against a workflow nobody changed. [FRAMING:representation]
    """
    yaml = YAML()
    yaml.indent(mapping=2, sequence=4, offset=2)
    yaml.width = 4096  # never reflow a long line into a continuation it did not have
    return yaml


def _plain(node: Any) -> Any:
    """Strip ruamel's containers down to dicts, lists and scalars.

    What crosses this boundary is ordinary Python, so nothing downstream can mutate a
    comment by accident, or read one without going through `Trivia`.
    [LAW:parse-dont-validate]
    """
    if isinstance(node, dict):
        return {key: _plain(value) for key, value in node.items()}
    if isinstance(node, list):
        return [_plain(value) for value in node]
    return node


def _tokens(slot: Any) -> tuple[CommentSpec, ...]:
    tokens = slot if isinstance(slot, list) else [slot]
    return tuple(
        CommentSpec(text=token.value, column=token.start_mark.column)
        for token in tokens
        if token is not None
    )


def _collect(node: Any, path: NodePath, found: list[Trivia]) -> None:
    attached = getattr(node, "ca", None)
    if attached is not None:
        if attached.comment and attached.comment[NODE_COMMENT_SLOT]:
            found.append(
                Trivia(
                    path=path,
                    key=None,
                    slot=NODE_COMMENT_SLOT,
                    comments=_tokens(attached.comment[NODE_COMMENT_SLOT]),
                )
            )
        for key, slots in (attached.items or {}).items():
            for index, slot in enumerate(slots):
                if slot:
                    found.append(
                        Trivia(path=path, key=key, slot=index, comments=_tokens(slot))
                    )
    if isinstance(node, dict):
        for key, value in node.items():
            _collect(value, (*path, key), found)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _collect(value, (*path, index), found)


def load(text: str, source: str) -> tuple[Any, tuple[Trivia, ...]]:
    """Parse a document into plain data and the comments that were hanging off it."""
    try:
        document = _yaml().load(text)
    except Exception as exc:  # ruamel raises several unrelated types for bad input
        raise YamlError(f"{source}: not valid YAML — {type(exc).__name__}: {exc}") from exc
    found: list[Trivia] = []
    _collect(document, (), found)
    return _plain(document), tuple(found)


def quoted(value: str) -> str:
    """A string that will be emitted in quotes whatever it spells.

    YAML resolves an unquoted `no`, `on`, `yes`, `off`, `5` or `null` to something that
    is not a string, and which words that covers differs between YAML 1.1 and 1.2 — so
    a value this installer round-trips faithfully can still reach the runner as a
    boolean. Every action input is a string by contract, so every one of them is
    quoted: unconditionally, rather than by a list of dangerous spellings that is one
    YAML revision away from being incomplete. [LAW:dataflow-not-control-flow]
    """
    return DoubleQuotedScalarString(value)


def _commented(node: Any) -> Any:
    if isinstance(node, dict):
        return CommentedMap((key, _commented(value)) for key, value in node.items())
    if isinstance(node, list):
        return CommentedSeq(_commented(value) for value in node)
    return node


def _at(root: Any, path: NodePath) -> Any:
    """The node at `path`, or None when the transformation removed it.

    A comment whose node no longer exists is dropped rather than raising: rebinding a
    step's `with:` block deletes the keys the old block's trivia named, and that is the
    ordinary case, not a fault. What it must NOT do is attach the orphan somewhere
    else, which is how a comment ends up explaining the wrong line.
    """
    node = root
    for step in path:
        try:
            node = node[step]
        except (KeyError, IndexError, TypeError):
            return None
    return node


def _addressable(node: Any) -> tuple[Key, ...]:
    """Every key or index `node` has, whatever kind of container it is."""
    if isinstance(node, dict):
        return tuple(node.keys())
    return tuple(range(len(node)))


def _restore(root: Any, trivia: tuple[Trivia, ...]) -> None:
    for item in trivia:
        node = _at(root, item.path)
        attached = getattr(node, "ca", None)
        if attached is None:
            continue
        tokens = [
            CommentToken(spec.text, CommentMark(spec.column), None) for spec in item.comments
        ]
        if item.key is None:
            attached.comment = [None, tokens]
            continue
        # `key in node` would be a VALUE test on a sequence, so every comment hanging
        # off a list index was dropped without a word — the exact failure this module
        # exists to stop, committed inside it. Ask the container the question it
        # actually answers. [LAW:no-silent-failure]
        if item.key not in _addressable(node):
            continue
        slots = attached.items.setdefault(item.key, [None, None, None, None])
        slots[item.slot] = tokens[0] if item.slot in SINGLE_TOKEN_SLOTS else tokens


def emit(data: Any, trivia: tuple[Trivia, ...]) -> str:
    """Render plain data back to YAML with its comments put back where they were."""
    document = _commented(data)
    _restore(document, trivia)
    stream = io.StringIO()
    _yaml().dump(document, stream)
    return stream.getvalue()
