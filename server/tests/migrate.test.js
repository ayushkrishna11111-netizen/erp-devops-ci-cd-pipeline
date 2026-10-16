// Unit tests for the database lock-guard in the migration runner
// (docs/DATABASE_LOCK_GUARD.md). No database needed — a fake pg client
// records the statements the runner issues.
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    migrate,
    findDestructive,
    applySessionGuardrails,
    explainGuardrailError,
    envInt,
} = require('../db/migrate');

const SAVE_ENV = { ...process.env };

function fakeClient({ appliedRows = [], onQuery } = {}) {
    const calls = [];
    return {
        calls,
        async query(text, params) {
            calls.push({ text, params });
            if (onQuery) {
                const forced = onQuery(text, params);
                if (forced !== undefined) return forced;
            }
            if (/SELECT filename, checksum FROM schema_migrations/.test(text)) {
                return { rows: appliedRows };
            }
            return { rows: [] };
        },
        release() { calls.push({ text: '__RELEASE__' }); },
    };
}

const fakePool = (client) => ({ connect: async () => client });

describe('lock-guard: session guardrails', () => {
    afterEach(() => { process.env = { ...SAVE_ENV }; });

    test('sets lock_timeout, statement_timeout and idle-tx timeout by default', async () => {
        const client = fakeClient();
        const { lockTimeoutMs, statementTimeoutMs } = await applySessionGuardrails(client, () => {});
        expect(lockTimeoutMs).toBe(5000);
        expect(statementTimeoutMs).toBe(300000);

        const sets = client.calls.filter((c) => c.text.includes('set_config'));
        const byName = Object.fromEntries(sets.map((c) => [c.params[0], c.params[1]]));
        expect(byName.lock_timeout).toBe('5000ms');
        expect(byName.statement_timeout).toBe('300000ms');
        expect(byName.idle_in_transaction_session_timeout).toBe('60000ms');
    });

    test('honours MIGRATION_LOCK_TIMEOUT_MS override', async () => {
        process.env.MIGRATION_LOCK_TIMEOUT_MS = '250';
        const client = fakeClient();
        await applySessionGuardrails(client, () => {});
        const set = client.calls.find((c) => c.params && c.params[0] === 'lock_timeout' && c.params[1] !== '0');
        expect(set.params[1]).toBe('250ms');
    });

    test('rejects a non-numeric timeout instead of silently disabling it', async () => {
        process.env.MIGRATION_LOCK_TIMEOUT_MS = 'soon';
        await expect(applySessionGuardrails(fakeClient(), () => {})).rejects.toThrow(/MIGRATION_LOCK_TIMEOUT_MS/);
    });

    test('envInt falls back and validates', () => {
        delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
        expect(envInt('MIGRATION_LOCK_TIMEOUT_MS', 5000)).toBe(5000);
        process.env.MIGRATION_LOCK_TIMEOUT_MS = '750';
        expect(envInt('MIGRATION_LOCK_TIMEOUT_MS', 5000)).toBe(750);
        // 0 would DISABLE the guardrail in Postgres (lock_timeout=0 = wait
        // forever), and negatives are nonsense — both must fail loudly.
        process.env.MIGRATION_LOCK_TIMEOUT_MS = '0';
        expect(() => envInt('MIGRATION_LOCK_TIMEOUT_MS', 5000)).toThrow(/positive integer/);
        process.env.MIGRATION_LOCK_TIMEOUT_MS = '-1';
        expect(() => envInt('MIGRATION_LOCK_TIMEOUT_MS', 5000)).toThrow(/positive integer/);
        process.env.MIGRATION_LOCK_TIMEOUT_MS = 'soon';
        expect(() => envInt('MIGRATION_LOCK_TIMEOUT_MS', 5000)).toThrow(/positive integer/);
    });
});

describe('lock-guard: error mapping', () => {
    test('lock timeout (55P03) becomes an actionable message', () => {
        const err = explainGuardrailError({ code: '55P03' }, '09_stuff.sql');
        expect(err.fatal).toBe(true);
        expect(err.message).toMatch(/09_stuff\.sql/);
        expect(err.message).toMatch(/lock_timeout/);
        expect(err.message).toMatch(/rolled back/);
    });

    test('statement timeout (57014) becomes an actionable message', () => {
        const err = explainGuardrailError({ code: '57014' }, '09_slow.sql');
        expect(err.fatal).toBe(true);
        expect(err.message).toMatch(/statement_timeout/);
    });

    test('unrelated errors pass through as null (original error is used)', () => {
        expect(explainGuardrailError(new Error('boom'), 'x.sql')).toBe(null);
    });
});

describe('lock-guard: destructive SQL still refused', () => {
    test('findDestructive spots DROP/RENAME/TRUNCATE/type change', () => {
        expect(findDestructive('DROP TABLE users;')).toBeTruthy();
        expect(findDestructive('ALTER TABLE users RENAME TO users_old;')).toBeTruthy();
        expect(findDestructive('TRUNCATE users;')).toBeTruthy();
        expect(findDestructive('ALTER TABLE users ALTER COLUMN id TYPE text;')).toBeTruthy();
        expect(findDestructive('ALTER TABLE users ADD COLUMN note TEXT;')).toBe(null);
        // mentions in comments do not trip the check
        expect(findDestructive('-- never DROP a column\nALTER TABLE users ADD COLUMN note TEXT;')).toBe(null);
    });
});

describe('migrate(): applied through the guarded runner', () => {
    let dir;
    beforeEach(() => {
        process.env = { ...SAVE_ENV };
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('applies a new file, then treats it as a no-op', async () => {
        fs.writeFileSync(path.join(dir, '01_x.sql'), 'CREATE TABLE IF NOT EXISTS t1 (id int);');

        const c1 = fakeClient();
        const logs1 = [];
        const applied = await migrate({ pool: fakePool(c1), log: (m) => logs1.push(m), dir });
        expect(applied).toEqual(['01_x.sql']);
        expect(c1.calls.some((c) => c.text === 'BEGIN')).toBe(true);
        expect(c1.calls.some((c) => c.text === 'COMMIT')).toBe(true);
        expect(logs1.join('\n')).toMatch(/lock_timeout=5000ms/);

        const appliedRow = c1.calls.find((c) => c.text.startsWith('INSERT INTO schema_migrations'));
        expect(appliedRow.params[0]).toBe('01_x.sql');

        // Second run: the file is already recorded with a matching checksum.
        const checksum = appliedRow.params[1];
        const c2 = fakeClient({ appliedRows: [{ filename: '01_x.sql', checksum }] });
        const logs2 = [];
        const applied2 = await migrate({ pool: fakePool(c2), log: (m) => logs2.push(m), dir });
        expect(applied2).toEqual([]);
        expect(logs2.join('\n')).toMatch(/up to date/);
    });

    test('refuses an edited, already-applied file', async () => {
        fs.writeFileSync(path.join(dir, '01_x.sql'), 'CREATE TABLE IF NOT EXISTS t1 (id int);');
        const c = fakeClient({ appliedRows: [{ filename: '01_x.sql', checksum: 'a'.repeat(64) }] });
        await expect(migrate({ pool: fakePool(c), log: () => {}, dir })).rejects.toThrow(/was modified after it was applied/);
    });

    test('refuses a destructive migration before running it', async () => {
        fs.writeFileSync(path.join(dir, '01_bad.sql'), 'DROP TABLE users;');
        const c = fakeClient();
        await expect(migrate({ pool: fakePool(c), log: () => {}, dir })).rejects.toThrow(/destructive statement/);
        expect(c.calls.some((x) => x.text === 'BEGIN')).toBe(false);
    });

    test('a lock-timeout during a migration rolls back and explains itself', async () => {
        fs.writeFileSync(path.join(dir, '01_lock.sql'), 'LOCK TABLE users;');

        const lockErr = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        const c = fakeClient({
            onQuery: (text) => {
                if (text === 'LOCK TABLE users;') throw lockErr;
                return undefined;
            },
        });

        await expect(migrate({ pool: fakePool(c), log: () => {}, dir })).rejects.toThrow(/could not acquire a lock within lock_timeout/);
        expect(c.calls.some((x) => x.text === 'ROLLBACK')).toBe(true);
        expect(c.calls.some((x) => x.text === 'COMMIT')).toBe(false);
    });

    test('the advisory lock is always released, even on failure', async () => {
        fs.writeFileSync(path.join(dir, '01_bad.sql'), 'DROP TABLE users;');
        const c = fakeClient();
        await expect(migrate({ pool: fakePool(c), log: () => {}, dir })).rejects.toThrow();
        expect(c.calls.some((x) => x.text.includes('pg_advisory_unlock'))).toBe(true);
        expect(c.calls.some((x) => x.text === '__RELEASE__')).toBe(true);
    });
});
