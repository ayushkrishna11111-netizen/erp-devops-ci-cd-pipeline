#!/usr/bin/env bash
# Install the repository's git hooks (docs/SECRET_SCANNING.md).
#
#   bash scripts/install-hooks.sh
#
# Installs .git/hooks/pre-commit which runs the same secret scan CI runs,
# against your STAGED files only — so your commit is blocked if it is about
# to leak a credential, but nothing already in the tree annoys you.
# The hook also runs gitleaks if you have it installed (optional).
set -euo pipefail

HOOK=.git/hooks/pre-commit

if [ ! -d .git ]; then
  echo "Run this from the repository root (no .git directory found)." >&2
  exit 1
fi

mkdir -p .git/hooks
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh — secret scan before every commit.
set -euo pipefail
echo "[pre-commit] secret scan (staged files)..."
node scripts/secret-scan.js --staged
if command -v gitleaks >/dev/null 2>&1; then
  echo "[pre-commit] gitleaks..."
  gitleaks protect --staged --redact --no-banner || {
    echo "gitleaks found a possible secret. Unstage it (git restore --staged <file>)," >&2
    echo "or mark a false positive with a 'secretscan:allow' comment." >&2
    exit 1
  }
else
  echo "[pre-commit] gitleaks not installed (optional): https://github.com/gitleaks/gitleaks"
fi
echo "[pre-commit] clean."
EOF

chmod +x "$HOOK"
echo "Installed $HOOK."
echo
echo "Reminder: CI still scans every tracked file and the full history, so a"
echo "bypassed hook cannot land a secret permanently — but rotating the"
echo "credential is the only real fix once it has been committed."
