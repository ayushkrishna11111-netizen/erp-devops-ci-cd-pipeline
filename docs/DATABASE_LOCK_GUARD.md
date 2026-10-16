# Database Lock Guard — protecting live transactions from deployments

**Addresses research limitation #1: *The Stateful Database Bottleneck* —
"standard CI/CD tools handle stateless web apps easily, but ERP systems rely
on massive, highly relational databases. Uncontrolled continuous deployment
can cause database locks, breaking live user transactions."**

## The failure mode this prevents

An ERP database is not a detail behind the app — it *is* the app. When a
deploy lands while people are working, two things can freeze the whole
business:

1. **A migration waits on a lock.** Someone is mid-invoice; their transaction
   holds a row/table lock. The deploy's migration needs that table, so it
   queues. In Postgres, a queued `ACCESS EXCLUSIVE` lock request also blocks
   the ordinary queries arriving *behind* it — every employee using the
   affected module now waits on the deploy. Without a timeout, they wait for
   as long as the migration does.
2. **An application session holds a lock and goes quiet.** A request handler
   opens a transaction, then hangs (slow downstream call, bug). Its locks
   stay until the connection dies — and the next migration, or the next
   employee, queues behind it.

## The guardrails

### Migration runner (`server/db/migrate.js`)

Before the first statement of any migration runs, the runner sets three
session-level timeouts:

| Setting | Default | Env var | Behaviour |
|---|---|---|---|
| `lock_timeout` | 5s | `MIGRATION_LOCK_TIMEOUT_MS` | A migration that cannot get a lock **aborts with `55P03` and rolls back** after the timeout. Live traffic is blocked for *at most* those seconds — never for the whole deploy queue. |
| `statement_timeout` | 5min | `MIGRATION_STATEMENT_TIMEOUT_MS` | A single runaway migration statement (e.g. an unbounded rewrite of a huge table) is cancelled (`57014`) and rolled back instead of running unbounded. |
| `idle_in_transaction_session_timeout` | 60s | `MIGRATION_IDLE_TX_TIMEOUT_MS` | If the runner itself dies between `BEGIN` and `COMMIT`, Postgres reclaims the session instead of leaving an idle-in-transaction blocker on the tables. |

Notes:

- The values are validated: a non-numeric or non-positive value **fails the
  deploy loudly** rather than silently disabling the guardrail (Postgres
  treats `0` as *wait forever*).
- The advisory lock that serialises concurrent runners is subject to
  `lock_timeout` too: two deploys starting together no longer stack up.
- A lock-timeout abort produces an actionable error naming the file, the
  timeout, and what to do (retry in a quieter window, or split the
  migration). The checksum ledger is untouched — the migration simply did
  not happen, and the next deploy retries it.

### Application pool (`server/db/pool.js`)

Every API connection inherits:

| Setting | Default | Env var |
|---|---|---|
| `statement_timeout` | 30s | `APP_STATEMENT_TIMEOUT_MS` |
| `idle_in_transaction_session_timeout` | 60s | `APP_IDLE_TX_TIMEOUT_MS` |

So a runaway query or a hung handler can no longer sit on ERP locks
indefinitely. `0` disables either.

## Proof, not promises

**Unit** — `server/tests/migrate.test.js` (no database needed): guardrails
are applied before the first migration statement, env overrides are honoured,
invalid values throw, lock/statement timeouts roll back and produce the
documented messages, the advisory lock is always released.

**End to end** — `scripts/db-lock-guard-check.js` runs against a real
Postgres and is wired into CI as the `db-lock-guard` job on every push/PR:

- **A.** a clean database migrates normally with the guardrails on;
- **B.** while a second session holds an `ACCESS EXCLUSIVE` lock on `users`,
  a migration needing that table **aborts at `lock_timeout`** (asserted:
  failure, message names the timeout, wall-clock bounded, the aborted
  migration is *not* recorded, and `SELECT` on the table works again
  immediately afterwards);
- **C.** a migration that sleeps past `statement_timeout` is killed and
  rolled back;
- **D.** a guarded re-run of the real migrations is still the idempotent
  "up to date" no-op.

Run it locally:

```bash
docker run -d --name erp-lockguard -p 5599:5432 \
  -e POSTGRES_USER=erp_user -e POSTGRES_PASSWORD=erp_password \
  -e POSTGRES_DB=erp_db postgres:15-alpine
DATABASE_URL=postgres://erp_user:erp_password@localhost:5599/erp_db \
  node scripts/db-lock-guard-check.js
```

## What this does *not* solve (and what to do about it)

- **A long migration is still long.** The guardrail bounds the *damage* of a
  blocked migration, not its duration. Keep migrations small and additive
  ([MIGRATION_SAFETY.md](MIGRATION_SAFETY.md)); build indexes with
  `CREATE INDEX CONCURRENTLY` in a non-transactional follow-up file when a
  table is large.
- **Session defaults for everyone.** For a hosted database, also set the
  defaults once, so *every* connection (including ad-hoc psql sessions):
  `ALTER DATABASE erp_db SET lock_timeout = '5s';`
  `ALTER DATABASE erp_db SET idle_in_transaction_session_timeout = '60s';`
- **Peak-hour deploys.** Timeouts make an ill-timed deploy survivable, not
  free. Schedule schema changes outside business hours where the ERP is used
  heaviest, and prefer expand → migrate data → contract across two releases.
