"""What the person who asked is TOLD when a run does not deliver a review.

`test_gate.py` runs the gate's decision script because the decision lives in bash rather
than in YAML. The same is true one step further on: whether a notice actually names what
happened is a fact about a shell `if`, and reading the workflow as data cannot see it.

The notices are the last thing standing between a maintainer and total silence. An
`issue_comment` run is attached to no commit, so it appears in NO check list on the pull
request — if the notice is missing, or arrives naming nothing, the asker cannot tell a dead
run from an uninstalled action. So this module executes each answering step against a
stubbed `gh` and asserts on the body that reaches the pull request.
[LAW:no-silent-failure]
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

from copirate_review.yamldoc import load as read_yaml

from .test_render import rendered_for

#: Every value `steps.review.outcome` can hold when the answering step runs. `failure` and
#: `cancelled` are the two a human most needs told about — the second is a job killed by its
#: own `timeout-minutes`, which is not a failure. The EMPTY STRING is the one that is not a
#: state name at all: the job died before the review step was ever reached, so the steps
#: context has no entry for it and the expression resolves to "".
NON_SUCCESS_OUTCOMES = ("failure", "cancelled", "skipped", "")

#: A code span with nothing in it — what a notice renders when it interpolates a state it
#: does not have. The asker reads "the review step ended ``" and learns nothing.
EMPTY_CODE_SPAN = re.compile(r"`\s*`")


def answering_step(tmp_path: Path, job: str) -> str:
    """The shell of `job`'s answering step, taken from the RENDERED workflow.

    Found the way `test_render.py` finds it — a step that posts a comment on a condition
    reading a step outcome — so the two cannot disagree about which step this is.
    """
    workflow, _ = read_yaml(rendered_for(tmp_path).text, "rendered")
    steps = workflow["jobs"][job]["steps"]
    return next(
        s["run"]
        for s in steps
        if "gh pr comment" in s.get("run", "") and ".outcome" in (s.get("if") or "")
    )


@pytest.fixture
def notice(tmp_path):
    """Run an answering step with a stubbed `gh`, and report what it posted.

    Returns a callable: `notice(job, outcome="")` -> list of posted comment bodies.
    """
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stub = stub_dir / "gh"
    stub.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then\n'
        "  while [ $# -gt 0 ]; do\n"
        '    if [ "$1" = "--body" ]; then printf \'%s\\n\' "$2" >> "$GH_STUB_COMMENTS"; fi\n'
        "    shift\n"
        "  done\n"
        "  exit 0\n"
        "fi\n"
        'echo "gh: unexpected call: $*" >&2\n'
        "exit 1\n"
    )
    stub.chmod(0o755)

    comments = tmp_path / "comments"

    def run(job, outcome=None):
        comments.write_text("")
        script = tmp_path / f"{job}.sh"
        script.write_text(answering_step(tmp_path, job))
        env = {
            **os.environ,
            "PATH": f"{stub_dir}{os.pathsep}{os.environ['PATH']}",
            "GH_TOKEN": "stub",
            "REPO": "acme/widgets",
            "PR_NUMBER": "557",
            "RUN_URL": "https://example.invalid/run/1",
            "GH_STUB_COMMENTS": str(comments),
        }
        # `outcome=None` means the variable is NOT EXPORTED AT ALL, which is different from
        # exporting it empty: under `set -u` an unexported read aborts the script, and an
        # aborted notice is silence.
        if outcome is not None:
            env["OUTCOME"] = outcome
        completed = subprocess.run(
            ["bash", str(script)], env=env, capture_output=True, text=True
        )
        assert completed.returncode == 0, (
            f"{job}'s notice must deliver, not abort: {completed.stderr}"
        )
        return [line for line in comments.read_text().splitlines() if line]

    return run


@pytest.mark.parametrize("outcome", NON_SUCCESS_OUTCOMES)
def test_the_review_notice_names_what_happened_for_every_outcome(notice, outcome):
    """Whatever the review step's outcome was, the notice says something true about it.

    The empty case is the one this was written for: `steps.review.outcome` resolves to ""
    when the job was cancelled before the review step began, and the notice interpolated it
    into a code span — telling the asker "the review step ended ``", which names no state at
    all. [LAW:no-silent-failure]
    """
    posted = notice("review", outcome)
    assert len(posted) == 1, f"exactly one notice, got {posted}"
    body = posted[0]
    assert "Review did not finish." in body
    assert not EMPTY_CODE_SPAN.search(body), f"the notice names no state: {body!r}"
    if outcome:
        assert f"`{outcome}`" in body, f"the outcome must be named; got {body!r}"


def test_the_review_notice_survives_an_unset_outcome(notice):
    """`set -u` plus an unexported OUTCOME would abort the one step that owes an answer.

    GitHub exports every name in an `env:` block, so this is belt and braces — but the cost
    of being wrong is the exact failure this step exists to end, and the guard is one `:-`.
    """
    posted = notice("review", outcome=None)
    assert len(posted) == 1, f"exactly one notice, got {posted}"
    assert not EMPTY_CODE_SPAN.search(posted[0])


def test_the_gate_notice_says_nothing_was_spent(notice):
    """The gate's notice can truthfully promise no cost; the review job's deliberately cannot.

    The gate refuses before any engine starts, so "nothing was spent" is a fact it holds. By
    the time the review job's notice runs, a review may have burned twenty minutes, and
    asserting a cost either way would be inventing one.
    """
    posted = notice("gate")
    assert len(posted) == 1, f"exactly one notice, got {posted}"
    assert "nothing was spent" in posted[0]
    assert "nothing was spent" not in notice("review", "failure")[0]
