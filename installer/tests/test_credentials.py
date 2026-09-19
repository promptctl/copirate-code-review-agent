"""Reading a declared credential: what each source promises, and how each one fails.

`security` is driven with a stand-in for the exit-status tests. The subject there is
how this module reads an EXIT STATUS, and a test depending on the machine's actual
keychain could only assert what happens to be filed on it today. The pipeline tests
use the environment source against real processes, because there the whole claim is
about what crosses an OS pipe. [LAW:behavior-not-structure]
"""

from __future__ import annotations

import pytest

from copirate_review import credentials
from copirate_review.credentials import EnvCredential, KeychainCredential, is_empty, pipe_into
from copirate_review.shell import EffectError


def stub(monkeypatch, exit_code: int, stderr: str = "") -> None:
    """Stand in for `security find-generic-password -s`, exiting however we ask."""
    monkeypatch.setattr(
        credentials, "_FIND", ["sh", "-c", f'printf %s "{stderr}" >&2; exit {exit_code}', "security"]
    )


def value_stub(monkeypatch) -> None:
    """Stand in for `security … -w`, which prints the value AND a trailing newline.

    That newline is the whole reason the `tr` stage exists, so a stand-in that omits it
    would let the empty-item guard pass a test it cannot pass against the real binary.
    """
    monkeypatch.setattr(credentials, "_FIND", ["sh", "-c", 'printf "%s\\n" "$1"', "security"])


# --- one item, and only that item -------------------------------------------------


def test_reading_the_keychain_asks_for_exactly_the_declared_item(monkeypatch):
    """The whole keychain is never listed, dumped, or searched by pattern.

    A reader that enumerated the keychain would put every credential on the machine
    into this process's reach for the sake of fetching one.
    """
    seen: list[list[str]] = []
    monkeypatch.setattr(
        credentials.subprocess, "run", lambda argv, **kw: seen.append(argv) or _ok()
    )
    KeychainCredential(item="ONE_ITEM").present()
    argv = seen[0]
    assert argv == ["security", "find-generic-password", "-s", "ONE_ITEM"]
    assert not any("dump" in part for part in argv)


def _ok():
    class Result:
        returncode = 0
        stdout = ""
        stderr = ""

    return Result()


# --- the three answers a keychain gives -------------------------------------------


def test_an_item_that_is_present_is_present(monkeypatch):
    stub(monkeypatch, 0)
    assert KeychainCredential(item="ANY").present() is True


def test_the_one_status_that_means_absent_means_absent(monkeypatch):
    stub(monkeypatch, credentials.ITEM_NOT_FOUND)
    assert KeychainCredential(item="ANY").present() is False


@pytest.mark.parametrize("code", [1, 51, 128], ids=["generic", "auth-failed", "cancelled"])
def test_a_keychain_we_could_not_read_is_never_reported_as_an_item_we_do_not_have(
    monkeypatch, code
):
    """Folding this into False sends the operator to add an item they already have.

    The caller treats False as "no credential on this machine" and says so — naming the
    wrong cause, and hiding the real one, which is usually a locked keychain.
    """
    stub(monkeypatch, code, stderr="SecKeychainSearchCopyNext failed")
    with pytest.raises(EffectError) as caught:
        KeychainCredential(item="CLAUDE_CODE_OAUTH_TOKEN_SIGNUP").present()
    message = str(caught.value)
    assert "CLAUDE_CODE_OAUTH_TOKEN_SIGNUP" in message
    assert str(code) in message
    assert "locked" in message


# --- the environment source -------------------------------------------------------


def test_an_exported_variable_is_present_and_an_unset_one_is_not(monkeypatch):
    monkeypatch.setenv("DECLARED_TOKEN", "value")
    monkeypatch.delenv("NEVER_EXPORTED", raising=False)
    assert EnvCredential(var="DECLARED_TOKEN").present() is True
    assert EnvCredential(var="NEVER_EXPORTED").present() is False


def test_an_environment_credential_reaches_the_consumer_byte_for_byte(monkeypatch):
    """No trailing newline is added, so the secret written is the secret exported."""
    monkeypatch.setenv("DECLARED_TOKEN", "sixteen-chars-xx")
    assert pipe_into(EnvCredential(var="DECLARED_TOKEN"), ["wc", "-c"]).strip() == "16"


def test_an_environment_credential_never_appears_in_the_readers_argv(monkeypatch):
    """`ps` shows every argument of every process on the machine.

    The variable's NAME is in argv, which is not the secret. Its value must not be.
    """
    monkeypatch.setenv("DECLARED_TOKEN", "the-actual-secret")
    stages = EnvCredential(var="DECLARED_TOKEN").stages
    assert not any("the-actual-secret" in part for stage in stages for part in stage)
    assert any("DECLARED_TOKEN" in part for stage in stages for part in stage)


def test_an_exported_but_empty_variable_is_empty(monkeypatch):
    """It would otherwise set an empty secret, and every review would fail to authenticate."""
    monkeypatch.setenv("DECLARED_TOKEN", "")
    assert is_empty(EnvCredential(var="DECLARED_TOKEN")) is True


# --- the pipeline, whichever source feeds it --------------------------------------


def test_the_pipeline_returns_what_the_consumer_said_and_never_the_value(monkeypatch):
    """The credential reaches the consumer's stdin; only the consumer's stdout returns."""
    value_stub(monkeypatch)
    assert pipe_into(KeychainCredential(item="sixteen-chars-xx"), ["wc", "-c"]).strip() == "16"


def test_an_empty_item_is_seen_as_empty_rather_than_as_one_newline(monkeypatch):
    """`security` prints a newline for an empty item; unstripped, that measures as 1."""
    value_stub(monkeypatch)
    assert is_empty(KeychainCredential(item="")) is True
    assert is_empty(KeychainCredential(item="a-real-token")) is False


def test_a_reader_that_fails_is_reported_as_the_reader_not_as_the_consumer(monkeypatch):
    """The consumer sees an empty stdin and may well succeed; the cause is upstream."""
    monkeypatch.setattr(credentials, "_FIND", ["sh", "-c", "echo nope >&2; exit 44", "security"])
    with pytest.raises(EffectError, match="reading keychain item GONE failed"):
        pipe_into(KeychainCredential(item="GONE"), ["wc", "-c"])


def test_a_consumer_that_rejects_the_write_is_reported_with_its_own_message(monkeypatch):
    """The readers die of EPIPE behind it, nonzero and silent, and blame the wrong end."""
    monkeypatch.setenv("DECLARED_TOKEN", "value")
    with pytest.raises(EffectError) as caught:
        pipe_into(EnvCredential(var="DECLARED_TOKEN"), ["sh", "-c", "echo denied >&2; exit 1"])
    assert "denied" in str(caught.value)
