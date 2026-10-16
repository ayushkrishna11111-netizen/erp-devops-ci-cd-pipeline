# Test Strategy — sharding, retries, quarantine and the nightly full suite

**Addresses research limitation #2: *Flaky Integration Tests & High Execution
Latency* — "ERP systems require complex end-to-end integration testing (e.g.
payment gateways, supply chain modules). Executing these full test suites on
every commit bloats build times to several hours."**

This repo's suites are still small (109 server tests, 7 client suites), but
the strategy is built now, before the suites are: the cost of adding it later
is a pipeline rewrite, and the cost of adding it now is one launcher script.

## The design in one table

| Pressure | Mechanism | Where |
|---|---|---|
| Suites grow past what one machine runs quickly | **Sharding** — server suites split across 2 parallel CI machines (`--shard`) | `quality-and-test` matrix in `ci.yml` |
| Transient failures (timing, ports, cold caches) fail builds that are actually fine | **Retries** — `JEST_RETRY=2` on PR runs, `3` nightly; a test that fails *every* attempt still fails the build | `server/tests/setupFlakyRetry.js`, client `setupTests.js` |
| One genuinely flaky suite blocks every release | **Quarantine** — it moves out of the PR gate and into a nightly-only lane; it never gets forgotten | `server/tests/quarantine.json`, `run-tests.js`, `nightly-suite.yml` |
| Slow tests are invisible | **JUnit XML artifacts** uploaded per shard, per run | `JEST_JUNIT=1` → `server/test-results/` |
| Superseded runs waste runner minutes | **Concurrency cancellation** for non-`main` refs | `concurrency:` block in `ci.yml` |
| PR gate is fast, truth is complete | **Nightly full suite** — everything, including quarantined suites, with harder retries | `.github/workflows/nightly-suite.yml` |

## How each piece works

### Sharding (`server/scripts/run-tests.js`)

`npm test` is a zero-dependency launcher around Jest. In CI it is invoked as:

```bash
SHARD=1 SHARD_TOTAL=2 JEST_RETRY=2 JEST_JUNIT=1 npm test   # matrix shard 1 of 2
```

Jest's native `--shard` splits the *file list*, so wall-clock time drops
roughly in half while total compute stays flat. Raise `SHARD_TOTAL` as the
suite grows — nothing else changes. Sharded runs pass `--passWithNoTests` so
an (unlikely) empty shard stays green.

### Retries

`JEST_RETRY=n` makes the suites call `jest.retryTimes(n)` — one flaky
attempt is retried before the test is declared failed. The failure budget is
per-test, not per-run: a test that fails all `n+1` attempts is a real failure
and still stops the pipeline. Retries are **off locally** so developers see
failures immediately; set `JEST_RETRY=2` manually to reproduce CI conditions.

### Quarantine (`server/tests/quarantine.json`)

When a suite is flaky *for real* (and not just having a bad day), quarantine
it deliberately rather than deleting or ignoring it:

```json
{ "path": "tests/integration.test.js",
  "reason": "supply-chain module test intermittently exceeds 15s on shared runners",
  "added": "2026-10-17",
  "issue": "#42" }
```

- **PR/push runs skip quarantined suites** (via `--testPathIgnorePatterns`),
  so a flaky suite cannot block a release. The skip is *announced* in the
  build log — it is visible, not silent.
- **Every night**, `nightly-suite.yml` runs them separately
  (`npm test -- --only-quarantined`) with `continue-on-error` and prints the
  quarantine list into the run summary. A quarantined suite that passes five
  nights in a row should be moved back into the normal run; one that keeps
  failing needs a fix or a deletion.
- The full nightly run also executes everything with `JEST_RETRY=3`.

### Commands

```bash
cd server && npm test                    # everything except quarantined suites
cd server && npm test -- --full          # include quarantined suites
cd server && npm test -- --only-quarantined   # just the quarantine lane
cd server && npm test -- auth            # path filter, passed straight to Jest
SHARD=2 SHARD_TOTAL=2 npm test           # one shard of two
```

## Honest numbers

Measured on the author's machine for this repo: the whole server suite
(109 tests, 10 suites) runs in ~6 seconds, so today the speedup from
sharding is seconds, not the hours the research describes. The pipeline is
built for the trajectory, not the current size: the same two knobs
(`SHARD_TOTAL`, quarantine) are what turn a 3-hour suite into a 15-minute
gate. The latency reduction that *is* real today is the concurrency
cancellation: a force-pushed PR no longer waits on — or is confused by — a
stale run of the previous commit.

## Rule of thumb for the team

- Unit-ish suite failing? Fix it; it is almost always real.
- Suite failing only on CI, only sometimes? Reproduce with
  `JEST_RETRY=3 npm test`; if it passes 10/10 locally but still flakes on
  CI, quarantine it *with a reason and a date* — never by deleting tests.
- Anything quarantined for more than two weeks without an issue linked is a
  bug in the process, not in the test.
