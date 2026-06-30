<!--
One fix or feature per PR (see CONTRIBUTING.md). Fill in the summary, then run
the self-check below before requesting review — CI enforces the same rules, but
catching them here is faster than a red build.
-->

## Summary

<!-- What this changes and why. Link any issue with "Closes #123". -->

## Self-check

The **shipped surface** is `src/`, `action.yml`, `review-agent/`, and the
`dist/` bundle built from them.

- [ ] **Does this PR touch the shipped surface?**
  - **No** (only `docs`, `scripts/`, `*.md`, CI config) → no version bump, no
    rebuild. Skip the rest of this section.
  - **Yes** → complete every box below.
- [ ] Ran `npm run build` and committed the regenerated `dist/` alongside `src/`.
- [ ] Bumped `package.json` `version` by the correct semver level (patch =
      bug/internal, minor = any consumer-visible change). See the release
      guidance in `CLAUDE.md`.
- [ ] If `action.yml` inputs changed, updated the README `## Inputs` table to
      match (run `node scripts/check-readme-inputs.js` — CI asserts this).

## Verification

- [ ] `npm test` passes.
- [ ] Described how the change was verified (tests added, local run, etc.).
