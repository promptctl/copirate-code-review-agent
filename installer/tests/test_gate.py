"""The comment-review gate's DECISIONS, exercised as the shell it ships as.

The gate is the one thing standing between a public comment box and a job that holds this
repository's secrets, and its whole job is refusing. Every other test in this suite reads
the workflow as data — which cannot tell whether the script inside it actually refuses a
fork, because that answer lives in bash, not in YAML. So this module runs the real script:
it renders the shipped base, lifts the gate step's `run:` body out of the rendered file,
and executes it against a stubbed `gh` with no network.

It asserts ONE fact per case — whether `review=true` was written, the single output that
starts a billed review — and never how the script reaches it, so the implementation stays
free to change. [LAW:behavior-not-structure] [LAW:verifiable-goals]
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from copirate_review.yamldoc import load as read_yaml

from .test_render import rendered_for

#: PR states the stub returns, as the gate's own three facts: is it open, and is the head
#: in this repository. Compared by numeric id, which is what makes a rename safe.
OPEN_SAME_REPO = '{"state":"open","headSha":"abc123","headRepoId":1,"baseRepoId":1}'
OPEN_FROM_FORK = '{"state":"open","headSha":"abc123","headRepoId":2,"baseRepoId":1}'
CLOSED = '{"state":"closed","headSha":"abc123","headRepoId":1,"baseRepoId":1}'

#: A body that executes `touch $CANARY` if — and only if — it is ever parsed by a shell
#: instead of being carried as data. A comment body is attacker-authored text, so this is
#: the difference between an input and a remote code execution on a runner holding secrets.
INJECTIONS = ("/review $(touch %s)", "/review `touch %s`")


def gate_script(tmp_path: Path) -> str:
    """The gate step's shell, taken from the RENDERED workflow rather than the base.

    Rendering is what a consumer runs, so a renderer that mangled the script would show up
    here instead of in production. [LAW:one-source-of-truth]
    """
    workflow, _ = read_yaml(rendered_for(tmp_path).text, "rendered")
    steps = workflow["jobs"]["gate"]["steps"]
    return next(step["run"] for step in steps if step.get("id") == "gate")


@pytest.fixture
def gate(tmp_path):
    """Run the gate with a stubbed `gh`, and report what it decided.

    Returns a callable: `gate(body, association, pr_json)` -> `(review, exit_code, canary)`
    where `review` is whether the run would start, and `canary` is True when an injected
    command actually executed.
    """
    script = tmp_path / "gate.sh"
    script.write_text(gate_script(tmp_path))

    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stub = stub_dir / "gh"
    # `gh pr comment` is recorded rather than answered: it is a SINK the gate writes to, and the
    # refusals it carries are the only thing the person who typed `/review` can see — an
    # issue_comment run is attached to no commit, so it appears in no check list on the PR.
    # Handled before GH_STUB_FAIL so the API-failure case fails the `gh api` call alone.
    stub.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then\n'
        '  while [ $# -gt 0 ]; do\n'
        '    if [ "$1" = "--body" ]; then printf \'%s\\n\' "$2" >> "$GH_STUB_COMMENTS"; fi\n'
        "    shift\n"
        "  done\n"
        "  exit 0\n"
        "fi\n"
        'if [ "${GH_STUB_FAIL:-}" = "1" ]; then echo "gh: API error" >&2; exit 1; fi\n'
        'printf \'%s\\n\' "$GH_STUB_JSON"\n'
    )
    stub.chmod(0o755)

    canary = tmp_path / "canary"
    comments = tmp_path / "comments"

    def run(body, association="OWNER", pr_json=OPEN_SAME_REPO, fail_api=False):
        output = tmp_path / "output"
        output.write_text("")
        summary = tmp_path / "summary"
        summary.write_text("")
        if canary.exists():
            canary.unlink()
        comments.write_text("")
        completed = subprocess.run(
            ["bash", str(script)],
            env={
                **os.environ,
                "PATH": f"{stub_dir}{os.pathsep}{os.environ['PATH']}",
                "GITHUB_OUTPUT": str(output),
                "GITHUB_STEP_SUMMARY": str(summary),
                "GH_TOKEN": "stub",
                "REPO": "acme/widgets",
                "PR_NUMBER": "557",
                "COMMENT_BODY": body,
                "COMMENT_AUTHOR": "someone",
                "AUTHOR_ASSOCIATION": association,
                "GH_STUB_JSON": pr_json,
                "GH_STUB_FAIL": "1" if fail_api else "0",
                "GH_STUB_COMMENTS": str(comments),
            },
            capture_output=True,
            text=True,
        )
        started = "review=true" in output.read_text().splitlines()
        return started, completed.returncode, canary.exists()

    run.canary = canary
    #: What the gate said on the pull request itself, one entry per posted comment.
    run.comments = lambda: [line for line in comments.read_text().splitlines() if line]
    return run


# --- what starts a review ---------------------------------------------------------


@pytest.mark.parametrize("association", ["OWNER", "MEMBER", "COLLABORATOR"])
def test_a_write_access_human_asking_starts_a_review(gate, association):
    started, _, _ = gate("/review", association=association)
    assert started


@pytest.mark.parametrize(
    "body",
    [
        "/review",
        "   /review",
        "/review please be thorough",
        "thanks!\n/review",
        "/review\n",
    ],
)
def test_the_command_is_recognised_wherever_a_line_begins_with_it(gate, body):
    started, _, _ = gate(body)
    assert started


def test_the_resolved_head_sha_is_published_for_the_checkout_to_use(gate, tmp_path):
    """The checkout and the review must anchor to ONE commit, resolved once."""
    started, _, _ = gate("/review")
    assert started
    assert "head-sha=abc123" in (tmp_path / "output").read_text().splitlines()
    assert "pr-number=557" in (tmp_path / "output").read_text().splitlines()


# --- what does not ----------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        "you can run /review here",
        "see https://example.dev/review",
        "/reviewers",
        "lgtm",
        "",
        "please review this",
    ],
)
def test_a_comment_that_does_not_ask_spends_nothing(gate, body):
    """A billed run must not start because a word appeared in prose."""
    started, code, _ = gate(body)
    assert not started
    assert code == 0


@pytest.mark.parametrize("association", ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"])
def test_someone_without_write_access_cannot_start_a_run(gate, association):
    """Otherwise a public comment box spends this repository's tokens on demand."""
    started, code, _ = gate("/review", association=association)
    assert not started
    assert code == 0


def test_a_fork_pull_request_is_refused_before_anything_is_checked_out(gate):
    """This trigger holds secrets, so fork code must never reach the runner.

    The refusal is reached in a job that performs no checkout, so it is ordered BEFORE any
    untrusted byte exists on disk — which is the property that makes the trigger safe.
    """
    started, code, _ = gate("/review", pr_json=OPEN_FROM_FORK)
    assert not started
    assert code == 0


def test_a_closed_pull_request_is_not_reviewed(gate):
    started, code, _ = gate("/review", pr_json=CLOSED)
    assert not started
    assert code == 0


# --- failing closed, and failing loudly -------------------------------------------


def test_an_api_failure_stops_the_job_rather_than_answering_permissively(gate):
    """A gate that fails open reviews a fork PR with secrets in scope.

    So the one external call has no `|| true` and no default: a failure must be a non-zero
    exit, not a plausible answer. [LAW:no-silent-failure]
    """
    started, code, _ = gate("/review", fail_api=True)
    assert not started
    assert code != 0


@pytest.mark.parametrize("template", INJECTIONS)
def test_an_attacker_authored_comment_body_is_data_and_never_executed(gate, template):
    """`${{ github.event.comment.body }}` inline would be substituted before bash parses it.

    The body reaches the script as an environment variable for exactly this reason. If this
    test ever fails, a comment on any pull request is remote code execution on a runner
    holding this repository's credentials.
    """
    _, _, executed = gate(template % gate.canary)
    assert not executed


@pytest.mark.parametrize("template", INJECTIONS)
def test_injection_in_a_body_that_is_not_even_a_command_is_inert(gate, template):
    body = ("hi " + template + " there") % gate.canary
    started, _, executed = gate(body.replace("/review", "notacommand"))
    assert not started
    assert not executed


# --- what the person who asked actually sees ---------------------------------------
#
# A refusal that reaches only the run log and the step summary reaches NOBODY: a run on
# `issue_comment` is attached to no commit, so unlike a `pull_request` run it appears in no
# check list on the pull request. Green-and-silent is indistinguishable from this action not
# being installed — the same "asked and got nothing" this base exists to end.
# [LAW:no-silent-failure]


@pytest.mark.parametrize(
    "case,kwargs,expected",
    [
        ("a fork", {"pr_json": OPEN_FROM_FORK}, "comes from a fork"),
        ("a closed PR", {"pr_json": CLOSED}, "not open"),
        ("a stranger", {"association": "NONE"}, "owner, member, or collaborator"),
    ],
)
def test_every_refusal_answers_on_the_pull_request(gate, case, kwargs, expected):
    started, code, _ = gate("/review", **kwargs)
    assert not started, case
    assert code == 0, f"{case}: a refusal is a decision, not a failure"
    posted = gate.comments()
    assert len(posted) == 1, f"{case}: exactly one answer, not none and not several"
    assert expected in posted[0], f"{case}: the answer says why — got {posted[0]!r}"


def test_a_comment_that_is_not_a_request_says_nothing_at_all(gate):
    """The gate runs on EVERY comment in the repository. Answering the ones that asked for
    nothing would turn every conversation on every pull request into a thread of refusals."""
    started, code, _ = gate("looks good to me, shipping this")
    assert not started
    assert code == 0
    assert gate.comments() == []


def test_a_started_review_is_not_announced_by_the_gate(gate):
    """The review itself speaks — the gate stays quiet on the path where a review follows, so
    an accepted request produces one artifact rather than two."""
    started, _, _ = gate("/review")
    assert started
    assert gate.comments() == []
