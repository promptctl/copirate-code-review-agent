'use strict';
const core = require('@actions/core');

// [LAW:no-ambient-temporal-coupling] The ONE owner of how this process ends on a signal. Two kinds of
// work run, in an order that is a property of this module and never of who happened to register first:
// STOPS run synchronously the instant the signal lands (killing engine process groups, so nothing keeps
// spending), then FINALIZERS run concurrently to record what the run can still record, and then the
// process exits with the signal's conventional code.
//
// It exists because the order used to be luck. Signal listeners fire in registration order, and the
// engine reaper's listener called process.exit synchronously, so any later listener that needed an
// await — posting what a cancelled run spent — was killed before its request left.
//
// The bound is the runner's, not a tuning knob: a cancelled GitHub Actions step (a newer push under
// cancel-in-progress, or timeout-minutes) is sent SIGINT, then SIGTERM 7.5s later, then SIGKILL 2.5s
// after that. SHUTDOWN_CEILING_MS sits under the first gap, so a shutdown the SIGINT starts exits on its
// own terms before the runner escalates. It is a termination ceiling: finalizers that finish sooner exit
// sooner, and a finalizer that hangs cannot hold the process past it.
const SHUTDOWN_CEILING_MS = 7_000;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

// [LAW:no-shared-mutable-globals] Both registries are owned here and changed only through the two
// registration functions below; nothing else reads them.
const stops = new Set();
const finalizers = new Set();
let installed = false;
let shuttingDown = false;

// Resolves once `promise` settles or `ms` passes, whichever is first, to whether it settled in time.
// Never rejects: a rejection is the promise's own caller's to report.
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const settle = () => { clearTimeout(timer); resolve(true); };
    promise.then(settle, settle);
  });
}

async function shutDown(signal) {
  for (const stop of stops) {
    try {
      stop();
    } catch (e) {
      core.error(`Shutdown on ${signal}: a stop step threw (${e.message}); continuing to the rest of shutdown.`);
    }
  }
  // [LAW:no-silent-failure] A finalizer that throws is named, and one that outlives the ceiling is named,
  // so a run that exits without recording what it meant to record says so in its last log lines.
  const finished = Promise.all([...finalizers].map(finalize => Promise.resolve()
    .then(() => finalize(signal))
    .catch(e => core.error(`Shutdown on ${signal}: a finalizer failed: ${e.message}`))));
  if (!(await within(finished, SHUTDOWN_CEILING_MS))) {
    core.error(`Shutdown on ${signal}: finalizers did not finish within ${SHUTDOWN_CEILING_MS}ms; exiting without them.`);
  }
  process.exit(SIGNAL_EXIT_CODES[signal]);
}

function install() {
  if (installed) return;
  installed = true;
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      // The runner follows SIGINT with SIGTERM while the first shutdown may still be recording. That
      // shutdown already owns the exit; a second would exit before the first finished.
      if (shuttingDown) return;
      shuttingDown = true;
      void shutDown(signal);
    });
  }
}

// Register a synchronous step that must run the moment a signal lands, before any finalizer.
function onSignalStop(stop) {
  install();
  stops.add(stop);
}

// Register an async finalizer, called with the signal's name. Returns the function that unregisters it.
function onSignalFinalize(finalize) {
  install();
  finalizers.add(finalize);
  return () => finalizers.delete(finalize);
}

module.exports = { SHUTDOWN_CEILING_MS, SIGNAL_EXIT_CODES, within, onSignalStop, onSignalFinalize };
