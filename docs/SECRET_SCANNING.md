# Secret Scanning — keeping credentials out of the repository

**Addresses research limitation #3: *Security & Secrets Exposure* —
"hardcoded database credentials or API keys frequently slip into GitHub
repositories when developers bypass local pre-commit security checks."**

The insight the research hands us: a check you can bypass is not a check.
So this project runs **the same scanner in three places** — the developer's
staging area, CI on every push, and the full git history nightly — with one
shared rule set, and the CI copy gates publication.

## Layer 1 — local, before the commit lands

```bash
bash scripts/install-hooks.sh     # installs .git/hooks/pre-commit
```

The hook runs `node scripts/secret-scan.js --staged`: only *staged* files are
scanned, so you are never blocked by something already in the tree. If you
use the [pre-commit](https://pre-commit.com) framework instead,
`.pre-commit-config.yaml` wires the same scanner plus gitleaks.

Both also run gitleaks when it is installed (optional, recommended):
https://github.com/gitleaks/gitleaks.

## Layer 2 — CI, un-bypassable (`.github/workflows/ci.yml`, job `secret-scan`)

Every push and pull request:

1. **scanner self-test** — the gate must first prove it can detect known
   fake credentials (`--selftest`, 16 assertions);
2. **every tracked file** is scanned;
3. **the full git history** is scanned, so a credential that was committed
   and later "removed" is still found.

Nothing publishes if this fails: `publish-ghcr`, `publish-and-deploy` and
the readiness gate all list `secret-scan` in `needs`. Scan reports are
uploaded as build artifacts.

## Layer 3 — nightly depth (`.github/workflows/nightly-suite.yml`)

A full-history re-scan plus gitleaks over the whole repository with
[`.gitleaks.toml`](../.gitleaks.toml) as a second opinion with different
rules — belt and braces, because two scanners miss different things.

## What the scanner looks for

`scripts/secret-scan.js` is zero-dependency Node (no binary to install, runs
identically on dev laptops and CI) with rules for:

- AWS access key IDs; GitHub tokens (`ghp_…`, `github_pat_…`); Slack tokens;
  Stripe secret keys; npm `_authToken`; literal JWTs (this API's tokens *are*
  bearer credentials); PEM private-key blocks;
- **credential assignments**: a variable name like `PASSWORD`, `SECRET`,
  `TOKEN`, `API_KEY`, `DATABASE_URL`, `JWT_SECRET`… assigned a literal string
  of 8+ characters;
- **forbidden tracked paths**: a real `.env`, `*.pem`/`*.key`, SSH private
  keys, `credentials.json` — even if the content scan somehow misses them.

## False positives — handled honestly

The scanner is deliberately blunt; when it is wrong, fix it visibly:

1. **Best:** make the value not-a-secret — read it from `process.env` (the
   rule ignores `process.env` references and `${…}` interpolations by
   design).
2. **One line:** append `secretscan:allow` to the offending line.
3. **Placeholder values:** published templates like `CHANGE_ME…`, compose
   defaults like `dev_secret_key`, and the deliberately-public demo
   passwords (`Admin123!` & co, printed in the README) are allowlisted in
   the scanner and in `.gitleaks.toml`.
4. **Whole file:** add a regex to `.secretscanignore` (last resort — the
   file is no longer checked).

The self-test pins all of these behaviours, so the allowlist cannot silently
rot into a bypass.

## If a real credential ever lands

Removing it from the tree does **not** un-leak it: it lives in git history
and in every fork and clone. The only fix is to **rotate the credential**
(database password, API token, JWT secret) at the provider, then scrub
history if it matters (`git filter-repo`) and force-push.

## Evidence this works

During development of this very fork the scanner flagged five places in the
*existing* test suite where credential-shaped literals sat in assignments —
exactly the pattern the research warns about. They were inert test values
(`longenough1`, `ci-token`, …), and were then explicitly allowlisted with a
comment saying why. The scanner finishing green is a decision recorded in
the repository, not an absence of checks.
