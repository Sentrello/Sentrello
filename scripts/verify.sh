#!/usr/bin/env bash
# Everything that has to be true before a commit, as one exit code.
#
#   bun run verify && git commit ...
#
# The three checks were always being run. The problem was reading their output
# rather than acting on it: in one session a lint fix was applied but never
# committed, a typecheck was reported clean from a cache predating a schema
# change, and a commit went in over a failing test — each time because the
# result was printed next to the commit rather than standing between the work
# and it.
#
# `tsc -b --force`, not `tsc -b`. The incremental build reported a repo clean
# while it referenced three columns that no longer existed.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
# Bun is not always on the PATH of whatever shell runs this — a hook, a CI
# step, an editor task. A gate that silently reports "bun: command not found"
# as a test failure is worse than no gate.
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null || { echo "  bun not found on PATH"; exit 1; }
failed=0

step() {
  local name="$1"
  shift
  printf '  %-12s ' "$name"
  local out
  if out="$("$@" 2>&1)"; then
    echo "ok"
  else
    echo "FAILED"
    printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
    failed=1
  fi
}

# Nothing here writes to the tree.
#
# This used to apply formatting and then compare `git status --porcelain`
# against what it was, which cannot see a change to a file that was already
# modified — every file being verified before a commit. So the gate wrote a
# fix, saw an unchanged porcelain line, and said ready: that is how a v0.3.0
# tag ended up pointing at a package.json its own CI rejects.
#
# The lint step below already fails on anything the formatter would fix, so
# checking is the whole job. Run `bunx biome check --write .` to apply.
step "typecheck" ./node_modules/.bin/tsc -b --force
if [ -x ./node_modules/.bin/biome ]; then
  step "lint" ./node_modules/.bin/biome check .
fi
# A test run that leaves an organization behind is a failure, even when green.
#
# Every suite here creates organizations and tidies them up afterwards. One
# that throws part-way through its cleanup leaves a row, and that row is not
# untidiness: the sign-in log resolves an attempt against an unknown address to
# the *oldest* organization on the instance, so a leftover silently becomes the
# one another repo's tests write their events against and then cannot find.
#
# It cost an afternoon. Two organizations stranded by a new module's test made
# 48 tests fail in a module nobody had touched, and the failures looked exactly
# like a real regression in it — timezones coming back undefined, routes
# answering 200 where 404 was expected. Nothing in any of them named the cause.
#
# So the state of the database after the tests is part of whether they passed.
step_leftovers() {
  local url="${DATABASE_URL:-postgres://sentrello:sentrello@localhost:5433/sentrello}"
  printf '  %-12s ' "leftovers"
  command -v psql >/dev/null || { echo "skipped (no psql)"; return; }

  local left
  left="$(psql "$url" -tAc 'select count(*) from organizations' 2>/dev/null)" || {
    echo "skipped (no database)"
    return
  }

  if [ "$left" = "0" ]; then
    echo "ok"
    return
  fi

  echo "FAILED"
  echo "      $left organization(s) left in the test database:"
  # Named, so whoever reads this knows which suite to look at rather than
  # having to open a database client to find out.
  psql "$url" -tA -F'  ' -c \
    'select id, name from organizations order by created_at limit 10' \
    2>/dev/null | sed 's/^/        /'
  echo "      A suite did not clean up. Delete them before trusting any run:"
  echo "        psql \"$url\" -c 'delete from organizations'"
  failed=1
}

step "tests" bun test
step_leftovers

if [ "$failed" -ne 0 ]; then
  printf '\n  not ready to commit\n'
  exit 1
fi
printf '\n  ready\n'
