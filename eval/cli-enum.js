'use strict';
// How a CLI flag whose accept set is a fixed VOCABULARY is parsed, owned once — the counterpart to
// cli-int.js, which owns the flags whose accept set is a numeric floor. They are two accept-set shapes,
// not one: an integer flag COERCES a string to a number and then bounds it, a vocabulary flag admits a
// listed value and nothing else. One module holding both would need an "and" to say what it does.
// [LAW:decomposition] [LAW:one-source-of-truth] both CLIs parse the same arm the same way, or the two
// halves of an A/B are not the same experiment.
//
// [LAW:effects-at-boundaries] EMPTY require graph, so both CLIs can import it at module load without
// spending their load-purity guarantee — the same property src/effort.js and cli-int.js are imported for.

// [LAW:parse-dont-validate] Parse a CLI flag as one of `allowed` — the accept set is exactly that list,
// so the returned value is a member of the vocabulary and nothing downstream re-checks which arm it is.
// [LAW:no-silent-failure] The rejected value is echoed and the vocabulary named, so a typo is located
// rather than guessed — and NEVER coalesced to a default: `--read-set=asigned` silently selecting the
// shipped arm would report the DEFAULT behavior under the other arm's name, which is an A/B that lies.
//
// Unlike parseIntAtLeast this needs no blank-value guard, and the difference is the point of having two
// parsers. Blank is catastrophic for an integer cap only because Number('') is 0 — a coercion step that
// invents a legal value out of nothing. There is no coercion here, so '' is refused by the membership
// test itself, exactly as 'asigned' is. The guard would be a second enforcement of a rule the accept set
// already states. [LAW:polishing-by-subtraction] [LAW:single-enforcer]
function parseOneOf(raw, flag, allowed) {
  if (!allowed.includes(raw)) {
    throw new Error(`${flag} must be one of ${allowed.join(', ')} (got ${JSON.stringify(raw)}).`);
  }
  return raw;
}

module.exports = { parseOneOf };
