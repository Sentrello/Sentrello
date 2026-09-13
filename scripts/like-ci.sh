#!/usr/bin/env bash
# Run the tests the way CI runs them, from a clean checkout.
#
#   bash scripts/like-ci.sh
#
# `bun run verify` passing on a developer's machine does not mean CI will pass,
# and the gap has cost days twice:
#
#   - **A different module tree.** A working checkout accumulates installs, and
#     `bun install` in it keeps what is already there. This repository had three
#     copies of better-auth; a fresh install resolves exactly one — and the copy
#     `better-auth/react` resolved to locally behaved differently from the one
#     CI got. The client threw while it was still being imported, which is not a
#     failing assertion but an unhandled error between tests, so the run
#     reported three failures and named none of them.
#
#   - **No sibling repositories.** Pro and Modules sit beside this one on a
#     development machine and are absent in CI, so anything that reads them
#     takes a different path there. A test that guards against a vacuous pass
#     fires as a hard failure instead.
#
#   - **A different environment.** `.env` is loaded automatically by bun and is
#     not in CI. A variable only that file sets is a variable CI does not have.
#
# So this clones the current HEAD into a temporary directory, installs from
# scratch, and runs with only the variables `.github/workflows/ci.yml` sets —
# except DATABASE_URL, which points at the database already running here.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

info() { printf '  %s\n' "$*"; }

info "cloning HEAD ($(git -C "$here" rev-parse --short HEAD))"
git clone -q --depth 1 "file://$here" "$work/checkout"
cd "$work/checkout"

info "installing from scratch"
bun install --silent

info "ephemeral keys"
bash scripts/gen-keys.sh >/dev/null

# The variables CI sets, and nothing else. DATABASE_URL is taken from the
# working checkout so this uses the database that is already up.
db="$(sed -n 's/^DATABASE_URL=//p' "$here/.env" | head -1)"
[ -n "$db" ] || { echo "no DATABASE_URL in $here/.env" >&2; exit 1; }
cat > "$work/ci.env" <<EOF
DATABASE_URL=$db
BETTER_AUTH_SECRET=ci-secret-not-used-outside-ci-0123456789abcdef
SENTRELLO_BASE_URL=http://localhost:3000
SENTRELLO_LICENSE_PUBLIC_KEY_PATH=./secrets/license_public.pem
SENTRELLO_LICENSE_TOKEN_PATH=./secrets/license_token.jwt
SENTRELLO_INSTANCE_ID=ci-instance
EOF

info "running the tests"
bun test --env-file="$work/ci.env"
