'use strict';
const { within, onSignalFinalize } = require('./shutdown');

// [FRAMING:parts-and-seams] What one run has SPENT: the usage record of every engine spawn attempt it
// made — the scout, every worker and sweep, every spawn-level retry, every pass a failover discarded, and
// every config a failover reached. It is minted ONCE at the run boundary, beside the token cap, and read by
// whichever exit the run takes: the posted review's footer, the notice a failed or cancelled run leaves,
// and the daily ledger.
//
// Before it existed the pass owned its spawn records, so three exits took their spend with them: a pass
// that threw, a pass failover retried, and a run a signal killed. [LAW:no-silent-failure]
//
// [LAW:no-shared-mutable-globals] Spend accrues while engines run, in several lanes at once, so this is
// OWNED mutable state with one API, like the token cap. attempt() is the only writer, and it records
// whichever way the attempt settles, from the usage the adapter seam stamps on its result or its error.
//
// [LAW:no-ambient-temporal-coupling] close() is the one phase change: it refuses every attempt not yet
// started and resolves once every started attempt has settled and been recorded, so "all the spend is
// in" is a state a reader awaits, never a sleep it hopes was long enough.
function mintSpendMeter() {
  const spent = [];
  let inFlight = 0;
  let closed = false;
  const settledWaiters = [];
  return {
    async attempt(config, run) {
      if (closed) throw new Error('Engine spawn refused: this run is ending, and its spend is being recorded.');
      inFlight++;
      try {
        const result = await run();
        spent.push({ config, usage: result.usage });
        return result;
      } catch (err) {
        // The adapter seam stamps every error with what the attempt spent: null when nothing ran.
        spent.push({ config, usage: err.usage });
        throw err;
      } finally {
        inFlight--;
        if (inFlight === 0) settledWaiters.splice(0).forEach(resolve => resolve());
      }
    },
    close() {
      closed = true;
      return inFlight === 0 ? Promise.resolve() : new Promise(resolve => settledWaiters.push(resolve));
    },
    // One usage record per settled attempt, in the order they settled; sumUsage folds them.
    usages: () => spent.map(s => s.usage),
    // The configs the recorded attempts ran on, each once, in first-use order.
    configs: () => [...new Set(spent.map(s => s.config))],
  };
}

// [LAW:types-are-the-program] The config a cost MARKER attributes a spend to. A marker records one model and
// one endpoint, and a later audit reprices the recorded tokens at that model's card. Spend that ran on
// configs sharing a model and an endpoint is attributed to the last of them. Spend a failover spread across
// models or endpoints has no single answer, so the marker states neither rather than repricing one config's
// tokens at another's rates; the figure itself is unaffected, since every spawn was priced by its own config.
// A run that recorded no attempt spent nothing on any config, so its marker is attributed to `fallback`,
// the config the run would have reported anyway.
function attributedConfig(configs, fallback) {
  if (configs.length === 0) return fallback;
  const last = configs[configs.length - 1];
  const baseUrl = c => c.endpoint && c.endpoint.baseUrl;
  const shared = configs.every(c => c.model === last.model && baseUrl(c) === baseUrl(last));
  return shared ? last : { ...last, model: undefined, endpoint: undefined };
}

// A reaped engine settles within milliseconds of its SIGKILL. This ceiling exists only so an adapter that
// never settles cannot cost the run its record: past it, whatever has settled is recorded.
const SPAWN_SETTLE_CEILING_MS = 2_000;

// [LAW:single-enforcer] The ONE place a run's spend is recorded when no posted review carries it. A run's
// review path is wrapped from its first spawn until its review has been delivered, and
// whichever exit comes first — a throw or a signal — claims the record. There is exactly one record:
// the claim is a promise, so a signal landing while a throw is still posting awaits that same post
// rather than starting a second one, and a throw that follows a signal-killed pass does the same.
//
// [LAW:no-ambient-temporal-coupling] DELIVERY is the other claim, and it is a promise too, so the two
// exits exclude each other as states rather than by timing. deliver(send) hands the review to the host
// and is refused once a record is claimed: a signal that killed the engines lets the pass resolve with the
// findings its workers recorded, and delivering that review as well would put two markers for one spend
// on the PR. A signal that lands once delivery has begun returns the delivery itself, so shutdown awaits
// the post rather than exiting under it; a delivery the host refuses records the spend as a failure,
// inside that same awaited promise. `send` covers everything the delivered run still owes, the ledger
// entry included, because the process exits as soon as the promise a signal returned settles.
//
// `record(cause)` is the mode's own sink (a PR notice plus the ledger, or a log line in repo mode).
// `onSignal` is the registration seam, injected so the signal arm is testable without signalling the
// test process. [LAW:effects-at-boundaries]
function guardSpend({ spend, record, onSignal = onSignalFinalize }) {
  let recording = null;
  let delivery = null;
  const claim = (cause) => {
    recording ??= within(spend.close(), SPAWN_SETTLE_CEILING_MS).then(() => record(cause));
    return recording;
  };
  const failed = (err) => claim(`The run failed: ${err.message}`);
  const unregister = onSignal((signal) => delivery
    ?? claim(`The run was stopped by ${signal} before it finished: a newer push cancels the in-flight review of an older one, and the job's timeout-minutes stops a run that outlives it.`));
  return {
    deliver(send) {
      if (recording !== null) {
        return Promise.reject(new Error('The review was not delivered: the run is ending, and its spend is being recorded as unfinished.'));
      }
      delivery = Promise.resolve().then(send).catch(err => failed(err).then(() => { throw err; }));
      return delivery;
    },
    failed,
    done: unregister,
  };
}

module.exports = { mintSpendMeter, attributedConfig, guardSpend, SPAWN_SETTLE_CEILING_MS };
