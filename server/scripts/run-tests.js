#!/usr/bin/env node
// Shard-aware, quarantine-aware Jest launcher (docs/TEST_STRATEGY.md).
//
// Directly addresses the two CI pain points for an ERP suite:
//   * LATENCY  — split the suites across parallel CI machines with
//                SHARD=1 SHARD_TOTAL=2 (Jest's native --shard);
//   * FLAKINESS — integration tests that still misbehave are moved to
//                tests/quarantine.json so they stop blocking every PR, while
//                retries absorb transient failures in the rest of the suite.
//
// Environment:
//   SHARD=n SHARD_TOTAL=m   run the n-th of m shards (set both)
//   RUN_QUARANTINED=true    include quarantined suites (or --full)
//   ONLY_QUARANTINED=true   run ONLY quarantined suites (--only-quarantined)
//   JEST_RETRY=n            retry each failed test n times before failing
//   JEST_JUNIT=1            emit JUnit XML under test-results/ (for CI upload)
//   JEST_MAX_WORKERS=n      override worker count
//
// Usage:
//   npm test                          # everything except quarantined suites
//   npm test -- --full                # include quarantined suites too
//   npm test -- --only-quarantined    # just the quarantined ones (nightly)
//   npm test -- auth                  # path-pattern args pass straight to Jest

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const QUARANTINE_FILE = path.join(__dirname, '..', 'tests', 'quarantine.json');

function loadQuarantine() {
    try {
        const raw = JSON.parse(fs.readFileSync(QUARANTINE_FILE, 'utf8'));
        const entries = (raw.entries || []).map((e) => (typeof e === 'string' ? { path: e } : e));
        return entries.filter((e) => e.path && typeof e.path === 'string');
    } catch (err) {
        // A malformed quarantine file must never silently skip tests.
        console.error(`[tests] cannot read ${QUARANTINE_FILE}: ${err.message}`);
        process.exit(1);
    }
}

function main() {
    const passthrough = process.argv.slice(2);
    const onlyQuarantined = passthrough.includes('--only-quarantined')
        || process.env.ONLY_QUARANTINED === 'true';
    const includeQuarantined = passthrough.includes('--full')
        || passthrough.includes('--only-quarantined')
        || process.env.RUN_QUARANTINED === 'true'
        || onlyQuarantined;
    const args = passthrough.filter((a) => a !== '--full' && a !== '--only-quarantined');

    const quarantined = loadQuarantine();

    if (onlyQuarantined) {
        if (quarantined.length === 0) {
            console.log('[tests] quarantine is empty — nothing to run.');
            process.exit(0);
        }
        args.push('--runTestsByPath', ...quarantined.map((e) => path.join(__dirname, '..', e.path)));
        console.log(`[tests] ONLY quarantined suites (${quarantined.length}):`);
        quarantined.forEach((e) => console.log(`         - ${e.path}${e.reason ? ` — ${e.reason}` : ''}`));
    } else {
        if (!includeQuarantined && quarantined.length > 0) {
            quarantined.forEach((e) => {
                args.push('--testPathIgnorePatterns', e.path);
            });
            console.log(`[tests] skipping ${quarantined.length} quarantined suite(s) (see tests/quarantine.json):`);
            quarantined.forEach((e) => console.log(`         - ${e.path}${e.reason ? ` — ${e.reason}` : ''}`));
        } else if (includeQuarantined && quarantined.length > 0) {
            console.log(`[tests] FULL RUN: including ${quarantined.length} quarantined suite(s).`);
        }

        const shard = Number(process.env.SHARD || 0);
        const total = Number(process.env.SHARD_TOTAL || 0);
        if (shard || total) {
            if (!shard || !total || total < 2 || shard < 1 || shard > total) {
                console.error(`[tests] SHARD/SHARD_TOTAL invalid (got SHARD=${process.env.SHARD} SHARD_TOTAL=${process.env.SHARD_TOTAL}); need 1 <= SHARD <= SHARD_TOTAL and SHARD_TOTAL >= 2.`);
                process.exit(1);
            }
            args.push('--shard', `${shard}/${total}`, '--passWithNoTests');
            console.log(`[tests] running shard ${shard}/${total}`);
        }

        const workers = process.env.JEST_MAX_WORKERS;
        if (workers) args.push('--maxWorkers', workers);
    }

    if (process.env.JEST_JUNIT === '1') {
        args.push('--reporters=default', '--reporters=jest-junit');
        process.env.JEST_JUNIT_OUTPUT_DIR = process.env.JEST_JUNIT_OUTPUT_DIR
            || path.join(__dirname, '..', 'test-results');
        // NB: JEST_JUNIT_UNIQUE_OUTPUT_NAME is deliberately NOT set — it
        // makes jest-junit generate a uuid via the `uuid` package, which
        // needs globalThis.crypto (Node >= 19) and crashes on this project's
        // Node 18. Each CI shard is its own runner, so the default
        // junit.xml name cannot collide.
    }

    const retry = Number(process.env.JEST_RETRY || 0);
    if (Number.isInteger(retry) && retry > 0) {
        console.log(`[tests] flaky-test retry enabled: up to ${retry} extra attempt(s) per test (JEST_RETRY).`);
    }

    const jestBin = require.resolve('jest/bin/jest');
    const res = spawnSync(process.execPath, [jestBin, ...args], {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
        env: process.env,
    });
    process.exit(res.status === null ? 1 : res.status);
}

main();
