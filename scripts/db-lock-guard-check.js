// Database lock-guard verification — proves the migration runner cannot lock
// live user transactions out of the database (limitation: "uncontrolled
// continuous deployment can cause database locks, breaking live user
// transactions").
//
// What it proves, against a REAL Postgres (CI service container or local
// Docker), end to end:
//   A. a clean database migrates normally with the guardrails on;
//   B. while another session holds an exclusive lock on a table a migration
//      needs, the migration ABORTS at lock_timeout (default 5s) with a clear
//      message instead of queueing behind traffic for minutes — and traffic
//      works again immediately afterwards;
//   C. a migration statement that runs too long is killed at
//      statement_timeout and rolled back;
//   D. guardrailed re-runs are still idempotent ("up to date" no-op).
//
// Usage (DATABASE_URL must point at a throwaway Postgres):
//   node scripts/db-lock-guard-check.js
//
// CI: .github/workflows/ci.yml job `db-lock-guard`.
// Local: docker run -d --name erp-lockguard -p 5599:5432 \
//          -e POSTGRES_USER=erp_user -e POSTGRES_PASSWORD=erp_password \
//          -e POSTGRES_DB=erp_db postgres:15-alpine
//        DATABASE_URL=postgres://erp_user:erp_password@localhost:5599/erp_db \
//          node scripts/db-lock-guard-check.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIGRATE = path.join(ROOT, 'server', 'db', 'migrate.js');

// See main(): keeps the event loop alive so a dangling pg promise can never
// make the process exit(0) in the middle of a check section.
let keepAlive = null;

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
    if (ok) { console.log(`  PASS  ${label}${detail ? ` (${detail})` : ''}`); pass += 1; }
    else { console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); fail += 1; }
};

function dbEnv(extra = {}) {
    return { ...process.env, DATA_STORE: 'postgres', ...extra };
}

// Run the migration runner against a specific migrations directory.
function runMigrate({ dir, env = {} }) {
    const started = Date.now();
    const res = spawnSync(process.execPath, ['-e', `
        require(${JSON.stringify(MIGRATE)})
            .migrate({ dir: ${JSON.stringify(dir)} })
            .then((applied) => { console.log('MIGRATE_OK ' + applied.join(',')); process.exit(0); })
            .catch((e) => { console.error('MIGRATE_ERR ' + e.message); process.exit(1); });
    `], { env: dbEnv(env), encoding: 'utf8', timeout: 180000 });
    return {
        ok: res.status === 0,
        output: `${res.stdout || ''}${res.stderr || ''}`.trim(),
        ms: Date.now() - started,
    };
}

async function waitUntilReady(Client, url) {
    for (let i = 0; i < 60; i += 1) {
        const c = new Client({ connectionString: url });
        try {
            await c.connect();
            await c.query('SELECT 1');
            await c.end();
            return;
        } catch (err) {
            await c.end().catch(() => {});
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    throw new Error(`Postgres at ${url} never became reachable`);
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.error('DATABASE_URL is required (use a throwaway database).');
        process.exitCode = 2;
        return Promise.resolve();
    }

    // Keep the event loop alive for the whole run. A pending pg promise on a
    // connection the server has closed never settles — without this timer
    // Node would see an empty loop and exit(0) MID-CHECK, silently reporting
    // success with half the sections unprinted. (Found the hard way: the
    // blocker's ROLLBACK promise could dangle exactly that way.) With the
    // interval in place, a wedged await instead hangs visibly and hits the
    // CI job timeout — a loud failure, never a quiet one.
    keepAlive = setInterval(() => {}, 500);

    // pg is a dependency of server/, so resolve it from there.
    const { Client } = require(path.join(ROOT, 'server', 'node_modules', 'pg'));

    console.log(`=== Database lock-guard check against ${url.replace(/:[^:@/]*@/, ':***@')} ===`);
    await waitUntilReady(Client, url);

    // ---- A. Baseline: guardrailed migration of a clean database ------------
    console.log('\n=== A. Clean database migrates with guardrails on ===');
    const base = runMigrate({});
    chk('baseline migrate exits 0', base.ok, base.output.split('\n').slice(-1)[0]);
    chk('guardrail banner is printed', /guardrails: lock_timeout=/.test(base.output));

    // ---- B. Lock contention: migration must abort, not block --------------
    console.log('\n=== B. Migration stuck behind a live lock aborts at lock_timeout ===');
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'lockguard-lock-'));
    fs.writeFileSync(path.join(tmpB, '99_guard_lock.sql'),
        'LOCK TABLE users IN ACCESS EXCLUSIVE MODE;\n');

    const blocker = new Client({ connectionString: url });
    // Swallow connection-level errors so a dying blocker cannot crash the
    // run with an unhandled 'error' event.
    blocker.on('error', () => {});
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
    console.log('  (blocker session holds an ACCESS EXCLUSIVE lock on users)');

    const lockRun = runMigrate({
        dir: tmpB,
        env: { MIGRATION_LOCK_TIMEOUT_MS: '3000' },
    });
    // Tear the blocker down without letting a dead connection wedge the
    // script: if the server has already closed the session, pg's promise for
    // ROLLBACK never settles, so race it against a short timeout.
    const settle = (promise, ms = 3000) => Promise.race([
        promise.catch(() => {}),
        new Promise((r) => setTimeout(r, ms).unref()),
    ]);
    await settle(blocker.query('ROLLBACK'));
    await settle(blocker.end());

    chk('blocked migration FAILED instead of hanging', !lockRun.ok);
    chk('failure message explains lock_timeout', /lock_timeout/.test(lockRun.output), lockRun.output.split('\n').slice(-1)[0]);
    chk(`aborted quickly (lock_timeout 3s, took ${(lockRun.ms / 1000).toFixed(1)}s)`, lockRun.ms < 15000);

    // Traffic must work immediately after the abort.
    const probe = new Client({ connectionString: url });
    await probe.connect();
    const t0 = Date.now();
    const after = await probe.query('SELECT count(*) FROM users').catch((e) => ({ err: e }));
    const probeMs = Date.now() - t0;
    await probe.end();
    chk('live traffic works right after the abort', !after.err && probeMs < 2000, `SELECT in ${probeMs}ms`);

    // The aborted migration must not be recorded.
    const rec = new Client({ connectionString: url });
    await rec.connect();
    const recorded = await rec.query('SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE $1', ['99_guard_%']);
    await rec.end();
    chk('aborted migration was not recorded', recorded.rows[0].n === 0);

    // ---- C. Statement timeout kills a runaway migration --------------------
    console.log('\n=== C. Runaway migration statement killed at statement_timeout ===');
    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'lockguard-sleep-'));
    fs.writeFileSync(path.join(tmpC, '99_guard_sleep.sql'),
        'SELECT pg_sleep(60);\n');
    const sleepRun = runMigrate({
        dir: tmpC,
        env: { MIGRATION_STATEMENT_TIMEOUT_MS: '2000' },
    });
    chk('sleeping migration FAILED', !sleepRun.ok);
    chk('failure message explains statement_timeout', /statement_timeout/.test(sleepRun.output), sleepRun.output.split('\n').slice(-1)[0]);
    chk(`killed early (timeout 2s, took ${(sleepRun.ms / 1000).toFixed(1)}s)`, sleepRun.ms < 15000);

    // ---- D. Guarded re-run is still a clean no-op --------------------------
    console.log('\n=== D. Guarded re-run of the real migrations is a no-op ===');
    const rerun = runMigrate({});
    chk('re-run exits 0', rerun.ok, rerun.output.split('\n').slice(-1)[0]);
    chk('re-run reports "up to date"', /up to date/.test(rerun.output));

    console.log(`\n================= RESULT: ${pass} passed, ${fail} failed =================`);
    clearInterval(keepAlive);
    // NB: set exitCode instead of process.exit() — process.exit() can
    // truncate buffered stdout when it is piped (CI logs), which hides the
    // very PASS/FAIL lines the job exists to show.
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
    clearInterval(keepAlive);
    console.error(err);
    process.exitCode = 1;
});
