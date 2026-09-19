"""Reading a credential source: the three answers, and the one that used to vanish.

`security` is driven with a stand-in here rather than the real binary. The subject is
how this module reads an EXIT STATUS, and a test that depended on the machine's actual
keychain could only assert what happens to be filed on it today.
"""

from __future__ import annotations

import pytest

from copirate_review import keychain
from copirate_review.shell import EffectError


def stub(monkeypatch, exit_code: int, stderr: str = "") -> None:
    """Stand in for `security find-generic-password -s`, exiting however we ask."""
    script = f'printf %s "{stderr}" >&2; exit {exit_code}'
    monkeypatch.setattr(keychain, "_FIND", ["sh", "-c", script, "security"])


def test_an_item_that_is_present_is_present(monkeypatch):
    stub(monkeypatch, 0)
    assert keychain.has_item("ANY") is True


def test_the_one_status_that_means_absent_means_absent(monkeypatch):
    stub(monkeypatch, keychain.ITEM_NOT_FOUND)
    assert keychain.has_item("ANY") is False


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
        keychain.has_item("CLAUDE_CODE_OAUTH_TOKEN_SIGNUP")
    message = str(caught.value)
    assert "CLAUDE_CODE_OAUTH_TOKEN_SIGNUP" in message
    assert str(code) in message
    assert "locked" in message


def value_stub(monkeypatch) -> None:
    """Stand in for `security … -w`, which prints the value AND a trailing newline.

    That newline is the whole reason the `tr` stage exists, so a stand-in that omits it
    would let the empty-item guard pass a test it cannot pass against the real binary.
    """
    monkeypatch.setattr(keychain, "_FIND", ["sh", "-c", 'printf "%s\\n" "$1"', "security"])


def test_the_pipeline_returns_what_the_consumer_said_and_never_the_value(monkeypatch):
    """The credential reaches the consumer's stdin; only the consumer's stdout returns."""
    value_stub(monkeypatch)
    assert keychain.pipe_into("sixteen-chars-xx", ["wc", "-c"]).strip() == "16"


def test_an_empty_item_is_seen_as_empty_rather_than_as_one_newline(monkeypatch):
    """`security` prints a newline for an empty item; unstripped, that measures as 1."""
    value_stub(monkeypatch)
    assert keychain.is_empty("") is True
    assert keychain.is_empty("a-real-token") is False


def test_a_reader_that_fails_is_reported_as_the_reader_not_as_the_consumer(monkeypatch):
    """The consumer sees an empty stdin and may well succeed; the cause is upstream."""
    monkeypatch.setattr(keychain, "_FIND", ["sh", "-c", "echo nope >&2; exit 44", "security"])
    with pytest.raises(EffectError, match="reading keychain item 'GONE' failed"):
        keychain.pipe_into("GONE", ["wc", "-c"])
