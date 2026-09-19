"""The command line: parse arguments, run the command, map failures onto exit codes."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import ConfigError
from .install import apply, build_plan, describe
from .shell import EffectError

#: Exit codes are a contract, not just zero-or-one: a caller that runs this before every
#: review needs to tell "your configuration is wrong" (fix a file, re-run) from "the
#: world did not cooperate" (gh is down, the keychain is locked) without parsing prose.
EXIT_OK = 0
EXIT_EFFECT_FAILED = 1
EXIT_BAD_CONFIG = 2


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="copirate-review",
        description=(
            "Converge the CoPirate code review action into a repository. Safe to run "
            "before every review: it re-renders each workflow, re-syncs each credential, "
            "and writes only what differs."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser(
        "install",
        help="render the workflows, sync the secrets, and land any change on this branch",
    )
    install.add_argument(
        "-C",
        "--directory",
        default=".",
        type=Path,
        help="run as if started in this directory (default: the current one)",
    )
    install.add_argument(
        "--dry-run",
        action="store_true",
        help="report exactly what a real run would do, and do none of it",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        current = build_plan(args.directory.resolve(), Path.home())
        describe(current)
        if not args.dry_run:
            apply(current)
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return EXIT_BAD_CONFIG
    except EffectError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return EXIT_EFFECT_FAILED
    return EXIT_OK
