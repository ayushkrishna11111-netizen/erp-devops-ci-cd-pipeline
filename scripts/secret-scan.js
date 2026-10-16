#!/usr/bin/env node
// Secret scanner — docs/SECRET_SCANNING.md.
//
// Research limitation addressed: "hardcoded database credentials or API keys
// frequently slip into GitHub repositories when developers bypass local
// pre-commit security checks." This gives the project ONE scanner that runs
// in three places with the same rules:
//   1. locally as a pre-commit hook (scripts/install-hooks.sh), scanning only
//      STAGED files so a commit is never rejected for something already in
//      the tree;
//   2. in CI on every push/PR (secret-scan job), scanning every TRACKED file;
//   3. nightly over the whole Git HISTORY, so a secret committed and later
//      removed from the tree is still found and rotated.
//
// Zero dependencies: plain Node, no gitleaks/trufflehog install required.
// Gitleaks runs too when available (see .gitleaks.toml), but this scanner is
// the gate that always works.
//
// Usage:
//   node scripts/secret-scan.js                # scan all tracked files
//   node scripts/secret-scan.js --staged       # scan files staged for commit
//   node scripts/secret-scan.js --history      # scan added lines in git history
//   node scripts/secret-scan.js --path FILE    # scan specific path(s)
//   node scripts/secret-scan.js --report out.json
//   node scripts/secret-scan.js --selftest     # verify the scanner itself
//
// False positives: prefer fixing the code; if a match is genuinely not a
// secret, add the file to .secretscanignore, or put `secretscan:allow` on the
// offending line, or list the literal value in ALLOWED_VALUES below.
//
// Exit codes: 0 = clean, 1 = findings, 2 = usage/environment error.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- rules ----
// Each rule: { name, test, severity } — `test` runs against one line at a time.
const RULES = [
    {
        name: 'aws-access-key-id',
        test: /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/,
    },
    {
        name: 'github-token',
        test: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    },
    {
        name: 'slack-token',
        test: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    },
    {
        name: 'stripe-secret-key',
        test: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    },
    {
        name: 'private-key-block',
        test: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    },
    {
        name: 'npm-auth-token',
        test: /_authToken\s*=\s*\S{8,}/,
    },
    {
        // A JWT is a real bearer credential for this API (JWT_SECRET signs
        // them), so a committed literal JWT is treated as a leak.
        name: 'jwt-literal',
        test: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    },
    {
        // Assignment of a credential-looking variable to a literal string.
        // Deliberately ignores ${...} interpolations, process.env references
        // and anything in ALLOWED_VALUES.
        name: 'credential-assignment',
        test: /\b(?:PASSWORD|PASSWD|SECRET|SECRET_KEY|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|DB_URL|JWT_SECRET|DOCKERHUB_TOKEN|DEPLOY_API_TOKEN)\b\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/i,
        valueGroup: 1,
    },
];

// Literal values that are published placeholders or inert by construction.
const ALLOWED_VALUE_PATTERNS = [
    /^CHANGE_ME/i,
    /change_?me/i,
    /example/i,
    /placeholder/i,
    /your[-_]/i,
    /^dummy/i,
    /^sample/i,
    /^demo/i,
    /local_?only/i,
    /localhost/i,
    /^test/i,
    /^fake/i,
    /redacted/i,
    /^\*+$/,
    /^<.*>$/,
    /^\$\{.*\}$/,
    /^\$\{\{.*\}\}$/,       // GitHub Actions expressions
    /^process\.env/,
    /^os\.env/,
    /^env\./i,
    /^x$/i,
    /^null$/,
    /^undefined$/,
    /^dev_secret_key$/,     // the documented development default (refused in production)
    /^local_deploy_token$/, // the documented compose default (staging/production refuse it)
    /^ci_gate_secret$/,     // CI readiness-gate throwaway value
    // Demo credentials that are deliberately public (printed in the README
    // and created only in demo mode). They authenticate nothing real.
    /^admin123!$/i,
    /^manager123!$/i,
    /^user123!$/i,
    /^pw123456$/,
    /^pw123456!$/,
    // Test-fixture values in server/tests — inert strings that authenticate
    // nothing and exist only to assert 401/200 behaviour.
    /^wrong-password$/i,
    /^longenough.$/i,
    /^ci-token$/i,
    /^jwt\.sign/,           // code, not a credential
];

const ALLOW_LINE_MARKER = 'secretscan:allow';

// Files whose content is never scanned (hashes, binaries, build output).
const SKIP_FILE_PATTERNS = [
    /(^|\/)node_modules\//,
    /(^|\/)\.git\//,
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)test-results\//,
    /(^|\/)build\//,
    /(^|\/)dist\//,
    /\.(?:png|jpe?g|gif|ico|webp|svgz?|woff2?|ttf|eot|mp4|zip|gz)$/i,
];

// Tracked paths that must never exist in the repository at all.
const FORBIDDEN_TRACKED_PATHS = [
    { test: /(^|\/)\.env$/, why: 'real .env file (only .env.example may be committed)' },
    { test: /(^|\/)\.env\.(?!example$|sample$|template$)/, why: 'environment file' },
    { test: /\.(?:pem|p12|pfx|key)$/i, why: 'key material' },
    { test: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/, why: 'SSH private key' },
    { test: /(^|\/)credentials(?:\.json)?$/, why: 'credentials file' },
];

// Optional repository-level file skip list (.secretscanignore): one regex per
// line, `#` comments, blank lines ignored. Used for files that are annoying
// to scan but genuinely contain no live credentials.
const IGNORE_FILE = path.join(ROOT, '.secretscanignore');
const ignorePatterns = (() => {
    try {
        return fs.readFileSync(IGNORE_FILE, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
            .map((l) => new RegExp(l));
    } catch {
        return [];
    }
})();

// ------------------------------------------------------------------ util ----
const isAllowedValue = (v) => ALLOWED_VALUE_PATTERNS.some((re) => re.test(v));

const redact = (s) => (s.length <= 8 ? `${s.slice(0, 3)}***` : `${s.slice(0, 6)}***`);

function scanLine(line) {
    if (line.includes(ALLOW_LINE_MARKER)) return [];
    const hits = [];
    for (const rule of RULES) {
        const m = rule.test.exec(line);
        if (!m) continue;
        if (rule.valueGroup && isAllowedValue(m[rule.valueGroup])) continue;
        hits.push({ rule: rule.name, evidence: redact(m[rule.valueGroup || 0]) });
    }
    return hits;
}

function scanContent(content, label, findings) {
    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
        for (const hit of scanLine(line)) {
            findings.push({ file: label, line: i + 1, ...hit });
        }
    });
}

function skippedFile(relPath) {
    return SKIP_FILE_PATTERNS.some((re) => re.test(relPath))
        || ignorePatterns.some((re) => re.test(relPath));
}

// ------------------------------------------------------------------ git ----
const git = (...args) => execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    // History patches can be huge (lockfiles over hundreds of commits);
    // 512MB is comfortably above what a full-history scan of this repo emits.
    maxBuffer: 512 * 1024 * 1024,
});

const gitOrNull = (...args) => {
    try {
        return git(...args);
    } catch (err) {
        console.error(`[secret-scan] git ${args[0]} failed: ${err.message.split('\n')[0]}`);
        return null;
    }
};

function trackedFiles() {
    return git('ls-files', '-z').split('\0').filter(Boolean);
}

function stagedFiles() {
    return git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
}

// Scan every line ADDED in history (git log -p), attributing findings to the
// commit that introduced them. Bounded by --max-commits (default 2000).
// Lockfiles are excluded from the diff stream (noise; also scanned as tracked
// files in the default mode anyway).
function scanHistory(maxCommits, findings) {
    const patch = gitOrNull('log', '-p', '--no-renames', `-n${maxCommits}`,
        '--format=commit %H', '--', '.',
        ':(exclude)*package-lock.json', ':(exclude)*yarn.lock');
    if (patch === null) {
        console.error('[secret-scan] history: git log -p failed — nothing scanned (is this a git checkout?)');
        return 0;
    }
    let commit = 'unknown';
    let file = '(unknown)';
    let scannedLines = 0;
    for (const line of patch.split(/\r?\n/)) {
        const c = /^commit ([0-9a-f]{40,})$/.exec(line);
        if (c) { commit = c[1]; continue; }
        const d = /^diff --git a\/(.+?) b\//.exec(line);
        if (d) { file = d[1]; continue; }
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        if (skippedFile(file)) continue;
        scannedLines += 1;
        for (const hit of scanLine(line.slice(1))) {
            findings.push({ file, commit: commit.slice(0, 12), line: '(added line)', ...hit });
        }
    }
    return scannedLines;
}

// ------------------------------------------------------------- reporting ----
function report(findings, jsonPath) {
    if (findings.length === 0) {
        console.log('SECRET SCAN: clean — no credentials found.');
    } else {
        console.error(`\nSECRET SCAN: ${findings.length} potential credential(s) found:\n`);
        for (const f of findings) {
            const where = f.commit ? `${f.file}@${f.commit}` : `${f.file}:${f.line}`;
            console.error(`  [${f.rule}] ${where}\n      evidence: ${f.evidence}`);
        }
        console.error('\nIf a match is a genuine placeholder, mark the line with "' + ALLOW_LINE_MARKER + '"');
        console.error('or add the file to .secretscanignore. If it is a REAL credential:');
        console.error('rotate it NOW — removing it from the tree does not un-leak it.');
    }
    if (jsonPath) {
        fs.writeFileSync(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2)}\n`);
        console.log(`Report written to ${jsonPath}`);
    }
    return findings.length === 0 ? 0 : 1;
}

// --------------------------------------------------------------- selftest --
function selftest() {
    console.log('Running secret-scan self-test...');
    const expectHit = (line, rule) => {
        const hits = scanLine(line);
        const found = hits.some((h) => h.rule === rule);
        console.log(`  ${found ? 'PASS' : 'FAIL'}  flags ${rule}`);
        return found;
    };
    const expectClean = (line, why) => {
        const hits = scanLine(line);
        console.log(`  ${hits.length === 0 ? 'PASS' : 'FAIL'}  ignores ${why}${hits.length ? ` (got ${hits.map((h) => h.rule).join(',')})` : ''}`);
        return hits.length === 0;
    };

    // Fixtures are assembled from fragments so that scanning this very file
    // does not flag its own test data — a complete secret never appears in
    // the source, only in memory.
    const part = (...xs) => xs.join('');
    const awsKey = part('AKIA', 'IOSFODNN7EXAMPLE');
    const ghToken = part('ghp_', 'abcdefghij', 'klmnopqrst', 'uvwxyz', '0123456789');
    const stripeKey = part('sk_live_', 'ABCDEFGHIJKLMNOPQRST');
    const dbName = part('postgres://erp_user:', 'supersecret123', '@db:5432/erp_db');
    const jwt = part('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N634W1Q9abc');

    let all = true;
    all = expectHit(`const key = "${awsKey}";`, 'aws-access-key-id') && all;
    all = expectHit(`token = "${ghToken}"`, 'github-token') && all;
    all = expectClean('url = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"', 'slack webhook URL (not a token)') && all;
    all = expectHit(`stripe = "${stripeKey}"`, 'stripe-secret-key') && all;
    all = expectHit(part('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'), 'private-key-block') && all;
    all = expectHit(`DATABASE_URL = "${dbName}"`, 'credential-assignment') && all;
    all = expectHit(`jwt = "${jwt}"`, 'jwt-literal') && all;

    all = expectClean('DATABASE_URL = process.env.DATABASE_URL || ""', 'process.env reference') && all;
    all = expectClean('const x = "${SOME_VAR}"', 'shell-style interpolation') && all;
    all = expectClean('POSTGRES_PASSWORD=CHANGE_ME_local_only', 'CHANGE_ME placeholder') && all;
    all = expectClean('JWT_SECRET: ${JWT_SECRET:-dev_secret_key}', 'compose default interpolation') && all;
    all = expectClean('password: "Admin123!"', 'published demo password (allowlisted)') && all;
    all = expectClean('const t = "xoxb-1234567890-abcdefghijklmnop" // secretscan:allow', 'marked line') && all;

    // Forbidden-path detection
    const pathHit = (p) => FORBIDDEN_TRACKED_PATHS.some((r) => r.test.test(p));
    all = pathHit('.env') && all;
    console.log(`  ${pathHit('.env') ? 'PASS' : 'FAIL'}  flags tracked .env`);
    all = pathHit('server/cert.pem') && all;
    console.log(`  ${pathHit('server/cert.pem') ? 'PASS' : 'FAIL'}  flags tracked .pem`);
    const cleanPath = !pathHit('.env.example');
    all = cleanPath && all;
    console.log(`  ${cleanPath ? 'PASS' : 'FAIL'}  allows .env.example`);

    console.log(`\nSELF-TEST ${all ? 'PASSED' : 'FAILED'}`);
    return all ? 0 : 1;
}

// ------------------------------------------------------------------ main ----
function main() {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const valueOf = (f, d) => {
        const i = argv.indexOf(f);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
    };

    if (has('--selftest')) {
        process.exitCode = selftest();
        return;
    }

    const findings = [];
    let scanned = 0;

    if (has('--history')) {
        const maxCommits = Number(valueOf('--max-commits', process.env.SECRET_SCAN_MAX_COMMITS || 2000));
        scanned = scanHistory(maxCommits, findings);
        console.log(`[secret-scan] history: scanned ${scanned} added line(s) across up to ${maxCommits} commit(s)`);
    } else if (has('--staged')) {
        const files = stagedFiles();
        console.log(`[secret-scan] staged: ${files.length} file(s)`);
        for (const rel of files) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || skippedFile(rel)) continue;
            scanned += 1;
            scanContent(fs.readFileSync(abs, 'utf8'), rel, findings);
            for (const r of FORBIDDEN_TRACKED_PATHS) {
                if (r.test.test(rel)) findings.push({ file: rel, line: '-', rule: 'forbidden-tracked-path', evidence: r.why });
            }
        }
    } else if (has('--path')) {
        const targets = argv.slice(argv.indexOf('--path') + 1).filter((a) => !a.startsWith('--'));
        for (const t of targets.length ? targets : [ROOT]) {
            const abs = path.resolve(ROOT, t);
            const walk = (p, rel) => {
                const st = fs.statSync(p);
                if (st.isDirectory()) {
                    for (const child of fs.readdirSync(p)) {
                        if (child === '.git' || child === 'node_modules') continue;
                        walk(path.join(p, child), `${rel}${child}/`);
                    }
                } else if (!skippedFile(rel)) {
                    scanned += 1;
                    scanContent(fs.readFileSync(p, 'utf8'), rel, findings);
                }
            };
            if (fs.existsSync(abs)) walk(abs, path.relative(ROOT, abs).split(path.sep).join('/') || '');
        }
        console.log(`[secret-scan] path: scanned ${scanned} file(s)`);
    } else {
        // Forbidden tracked paths first — a path violation is a finding even
        // if the content scan misses (e.g. .env that only holds one key).
        for (const rel of trackedFiles()) {
            for (const r of FORBIDDEN_TRACKED_PATHS) {
                if (r.test.test(rel)) findings.push({ file: rel, line: '-', rule: 'forbidden-tracked-path', evidence: r.why });
            }
        }
        const files = trackedFiles();
        console.log(`[secret-scan] tracked: ${files.length} file(s)`);
        for (const rel of files) {
            if (skippedFile(rel)) continue;
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue; // deleted but still listed
            let content;
            try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
            if (content.includes('\u0000')) continue; // binary
            scanned += 1;
            scanContent(content, rel, findings);
        }
    }

    console.log(`[secret-scan] ${scanned} file(s) scanned, ${findings.length} finding(s)`);
    // NB: exitCode, not process.exit() — the latter can truncate buffered
    // stdout when piped into CI logs.
    process.exitCode = report(findings, valueOf('--report', null));
}

// Allow requiring for tests without running a scan.
if (require.main === module) main();

module.exports = { scanLine, scanContent, RULES, FORBIDDEN_TRACKED_PATHS, isAllowedValue };
