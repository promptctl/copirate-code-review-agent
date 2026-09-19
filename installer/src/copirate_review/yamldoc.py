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
from typing import Annotated, Any

from pydantic import BaseModel, Field
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
    #: At least one, because a `Trivia` carrying none is not a fact about the document
    #: — it is a record of a place where nothing was written. `_restore` reads
    #: `comments[0]` for the single-token slots, so an empty one is also an IndexError
    #: escaping as a bare traceback, past the exit codes `cli.py` contracts for. Both
    #: are closed by the state not existing. [LAW:types-are-the-program]
    comments: Annotated[tuple[CommentSpec, ...], Field(min_length=1)]


class KeyOrder(BaseModel):
    """The order one mapping's keys were written in.

    Only mappings with more than one key are recorded: a mapping with one key or none
    has exactly one order, so there is nothing to remember and nothing that can drift.
    """

    model_config = {"frozen": True}

    path: NodePath
    keys: tuple[Key, ...]


class Layout(BaseModel):
    """Everything about a document that its data does not carry.

    Comments and key order are the same KIND of fact, which is why one type holds both:
    neither survives a round trip through plain data, both are how a reader navigates
    the file, and losing either produces a document that is correct and misleading.

    Key order looks like formatting until you remember where ruamel attaches trivia —
    to the node BEFORE it. Reordering keys therefore MOVES COMMENTS. A base whose
    `env:` block carries the paragraph explaining why the runner needs a proxy, written
    above `jobs:`, renders with that paragraph sitting on `jobs:` instead, telling a
    reader that removing `jobs:` breaks the checkout. That is the exact failure `_at`
    refuses to commit one comment at a time, arriving wholesale through the serializer.
    [FRAMING:representation]
    """

    model_config = {"frozen": True}

    trivia: tuple[Trivia, ...] = ()
    order: tuple[KeyOrder, ...] = ()


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
    # Quote style is MEANING here, not formatting, so it is carried rather than
    # re-derived. ruamel decides quoting by what YAML 1.2 requires, and GitHub Actions
    # parses YAML 1.1 — so a base author's `verbose: 'no'` came back as bare `no`,
    # which 1.2 calls a string and 1.1 calls false. The installer renders a copy of
    # someone's workflow; a copy that means something different from its original is
    # the one thing it may never produce. [FRAMING:representation]
    yaml.preserve_quotes = True
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
        # The TOKENS decide, not the slot. A slot can be truthy and still yield nothing
        # — a list holding only `None` — and "is there a slot here" was never the
        # question this asks. [LAW:parse-dont-validate]
        block = _tokens(attached.comment[NODE_COMMENT_SLOT]) if attached.comment else ()
        if block:
            found.append(
                Trivia(path=path, key=None, slot=NODE_COMMENT_SLOT, comments=block)
            )
        for key, slots in (attached.items or {}).items():
            for index, slot in enumerate(slots):
                comments = _tokens(slot) if slot else ()
                if comments:
                    found.append(
                        Trivia(path=path, key=key, slot=index, comments=comments)
                    )
    if isinstance(node, dict):
        for key, value in node.items():
            _collect(value, (*path, key), found)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _collect(value, (*path, index), found)


def _shape(node: Any, path: NodePath, found: list[KeyOrder]) -> None:
    if isinstance(node, dict):
        if len(node) > 1:
            found.append(KeyOrder(path=path, keys=tuple(node.keys())))
        for key, value in node.items():
            _shape(value, (*path, key), found)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _shape(value, (*path, index), found)


def load(text: str, source: str) -> tuple[Any, Layout]:
    """Parse a document into plain data and everything about it the data cannot hold."""
    try:
        document = _yaml().load(text)
    except Exception as exc:  # ruamel raises several unrelated types for bad input
        raise YamlError(f"{source}: not valid YAML — {type(exc).__name__}: {exc}") from exc
    trivia: list[Trivia] = []
    _collect(document, (), trivia)
    order: list[KeyOrder] = []
    _shape(document, (), order)
    return _plain(document), Layout(trivia=tuple(trivia), order=tuple(order))


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


def _reorder(root: Any, order: tuple[KeyOrder, ...]) -> None:
    """Put each mapping's keys back in the order they were written in.

    Tolerant in both directions, because the transformation between load and emit is
    allowed to change the document: a key the recorded order names and the data no
    longer has is skipped, and a key the data has that the record never saw keeps its
    position relative to the others and follows them. Neither is a fault — one is a
    rebinding that removed a key, the other one that added one.

    Done BEFORE the comments go back. Re-keying a `CommentedMap` drops what is attached
    to the keys it moves, and `_restore` is the thing that knows where those belong.
    [LAW:no-ambient-temporal-coupling]
    """
    for item in order:
        node = _at(root, item.path)
        if not isinstance(node, dict):
            continue
        recorded = [key for key in item.keys if key in node]
        wanted = recorded + [key for key in node if key not in item.keys]
        if wanted == list(node):
            continue
        values = {key: node[key] for key in wanted}
        for key in list(node):
            del node[key]
        node.update(values)


def emit(data: Any, layout: Layout) -> str:
    """Render plain data back to YAML, laid out the way it was written."""
    document = _commented(data)
    _reorder(document, layout.order)
    _restore(document, layout.trivia)
    stream = io.StringIO()
    _yaml().dump(document, stream)
    return stream.getvalue()
