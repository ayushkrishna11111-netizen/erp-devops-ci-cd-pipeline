// Migration runner for existing databases (hosted Postgres on Render, etc.).
//
// Docker's initdb only runs server/db/*.sql on a brand-new volume, so an
// existing database never receives new files. This runner closes that gap:
//   * applies every db/NN_*.sql file not yet recorded, in filename order,
//     each in its own transaction, and records it in schema_migrations;
//   * records a checksum, and refuses to continue if an already-applied file
//     has since been edited (fix forward with a new file instead);
//   * takes a Postgres advisory lock so two instances starting together
//     cannot migrate concurrently;
//   * sets session guardrails before touching anything — a bounded
//     `lock_timeout` (default 5s) and `statement_timeout` (default 5min) —
//     so a migration that cannot get a lock ABORTS IN SECONDS instead of
//     queueing behind (and blocking) live user transactions. See
//     docs/DATABASE_LOCK_GUARD.md;
//   * refuses destructive statements (DROP, RENAME, column type changes),
//     which would break the previous image during a rollback window — see
//     docs/MIGRATION_SAFETY.md. Override only deliberately with
//     ALLOW_DESTRUCTIVE_MIGRATIONS=true.
//
// Every existing file is written idempotently (IF NOT EXISTS / ON CONFLICT),
// so running this against a database that initdb already set up is safe: the
// files re-apply as no-ops and are then recorded.
//
// Usage: `npm run migrate` (uses DATABASE_URL), or on startup via
// MIGRATE_ON_START (default on for Postgres, see server.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MIGRATIONS_DIR = __dirname;
const LOCK_KEY = 301301; // arbitrary, project-specific advisory lock id

const DESTRUCTIVE = [
    /\bDROP\s+(TABLE|COLUMN|SCHEMA|INDEX|CONSTRAINT|TYPE)\b/i,
    /\bRENAME\s+(TO|COLUMN)\b/i,
    /\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i,
    /\bTRUNCATE\b/i
];

const listMigrationFiles = (dir = DEFAULT_MIGRATIONS_DIR) => fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

// Errors in the migrations themselves are fatal: retrying cannot fix them.
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

const checksum = (sql) => crypto.createHash('sha256').update(sql).digest('hex');

// Strip comments so a rule mentioned in prose ("never DROP a column") does not trip the check.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

function findDestructive(sql) {
    const code = stripComments(sql);
    const hit = DESTRUCTIVE.find((re) => re.test(code));
    return hit ? code.match(hit)[0] : null;
}

/**
 * Read a positive-integer environment variable with a fallback.
 * Invalid values are a configuration bug, not something to guess around:
 * they throw so the deploy fails loudly instead of silently running
 * without the guardrail.
 */
function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw fatal(`${name} must be a positive integer (got "${raw}").`);
    }
    return n;
}

/**
 * Apply the session guardrails BEFORE the first migration statement runs.
 *   * lock_timeout — how long any lock the migration needs may WAIT. When it
 *     expires Postgres raises 55P03 (lock_not_available) and the migration
 *     rolls back; live traffic is blocked for at most this long, not for
 *     however long the deploy would have waited.
 *   * statement_timeout — hard ceiling on a single migration statement, so a
 *     full-table rewrite on a huge table cannot run unbounded.
 *   * idle_in_transaction_session_timeout — if the runner itself dies between
 *     BEGIN and COMMIT, Postgres reclaims the session instead of leaving an
 *     idle-in-transaction blocker on the tables forever.
 */
async function applySessionGuardrails(client, log = console.log) {
    const lockTimeoutMs = envInt('MIGRATION_LOCK_TIMEOUT_MS', 5000);
    const statementTimeoutMs = envInt('MIGRATION_STATEMENT_TIMEOUT_MS', 300000);
    const idleTxTimeoutMs = envInt('MIGRATION_IDLE_TX_TIMEOUT_MS', 60000);

    await client.query("SET lock_timeout = '0'", null); // never inherit a stale value
    await client.query('SELECT set_config($1, $2, false)', ['lock_timeout', `${lockTimeoutMs}ms`]);
    await client.query('SELECT set_config($1, $2, false)', ['statement_timeout', `${statementTimeoutMs}ms`]);
    await client.query('SELECT set_config($1, $2, false)', ['idle_in_transaction_session_timeout', `${idleTxTimeoutMs}ms`]);
    log(`[migrate] guardrails: lock_timeout=${lockTimeoutMs}ms statement_timeout=${statementTimeoutMs}ms idle_tx_timeout=${idleTxTimeoutMs}ms`);
    return { lockTimeoutMs, statementTimeoutMs, idleTxTimeoutMs };
}

// Turn Postgres' lock-timeout error into an actionable message. 55P03 is
// lock_not_available (what lock_timeout raises); 57014 is query_canceled
// (statement_timeout).
function explainGuardrailError(err, file) {
    if (err && err.code === '55P03') {
        return fatal(
            `${file} could not acquire a lock within lock_timeout (default 5s, tune with MIGRATION_LOCK_TIMEOUT_MS) ` +
            `and was rolled back. Live traffic was blocked for at most that long and is now unblocked. ` +
            `The migration is probably waiting on an open transaction on a table it touches — ` +
            `retry in a quieter window or split the migration (docs/DATABASE_LOCK_GUARD.md).`
        );
    }
    if (err && err.code === '57014') {
        return fatal(
            `${file} hit statement_timeout (default 5m, tune with MIGRATION_STATEMENT_TIMEOUT_MS) and was rolled back. ` +
            `A statement in it ran too long for a live database — split it into smaller steps.`
        );
    }
    return null;
}

async function migrate({ pool, log = console.log, dir = DEFAULT_MIGRATIONS_DIR } = {}) {
    const db = pool || require('./pool').pool;
    const client = await db.connect();
    const applied = [];

    try {
        await applySessionGuardrails(client, log);
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            filename   VARCHAR(255) PRIMARY KEY,
            checksum   CHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

        const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
        const done = new Map(rows.map((r) => [r.filename, r.checksum]));

        for (const file of listMigrationFiles(dir)) {
            const sql = fs.readFileSync(path.join(dir, file), 'utf8');
            const sum = checksum(sql);

            if (done.has(file)) {
                if (done.get(file) !== sum) {
                    throw fatal(`${file} was modified after it was applied. Do not edit applied migrations; add a new file instead.`);
                }
                continue;
            }

            const destructive = findDestructive(sql);
            if (destructive && process.env.ALLOW_DESTRUCTIVE_MIGRATIONS !== 'true') {
                throw fatal(`${file} contains a destructive statement ("${destructive}"). Migrations must be additive (docs/MIGRATION_SAFETY.md).`);
            }

            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, sum]);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw explainGuardrailError(err, file) || fatal(`${file} failed and was rolled back: ${err.message}`);
            }
            applied.push(file);
            log(`[migrate] applied ${file}`);
        }

        log(`[migrate] ${applied.length ? `${applied.length} applied` : 'up to date'}`);
        return applied;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        client.release();
    }
}

module.exports = {
    migrate,
    findDestructive,
    listMigrationFiles,
    applySessionGuardrails,
    explainGuardrailError,
    envInt
};

if (require.main === module) {
    migrate()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(`[migrate] FAILED: ${err.message}`);
            process.exit(1);
        });
}
