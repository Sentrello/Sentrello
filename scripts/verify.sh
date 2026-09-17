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

# --- which database the tests use --------------------------------------------
#
# One database per repository, chosen here rather than left to whoever happens
# to be calling. Every repository used to default to a single shared
# `sentrello` database, which failed in three ways on 2026-09-17 alone:
#
#   - It collected 313 tables across 14 schemas, because five suites had been
#     writing into it through their commit hooks. A run there fails on another
#     repository's migrations, so the failures name files nobody touched.
#   - Two sessions running at once fail each other's `leftovers` check, since a
#     row one suite is mid-way through creating is a row the other calls litter.
#   - The remedy this script printed for that was an unscoped `delete from
#     organizations`, which somebody duly ran against the shared database.
#
# Exported, not local: `bun test` reads DATABASE_URL from the environment, so a
# default that only reached psql left the tests themselves pointed elsewhere —
# which is exactly how a commit hook came to run against the wrong database.
export DATABASE_URL="${DATABASE_URL:-postgres://sentrello:sentrello@localhost:5433/sentrello_t_core}"

# Three things this must never be allowed to point at. The suites truncate
# tables; being wrong about where is not recoverable by reading the output
# afterwards.
case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "  refusing to run tests against a remote database: $DATABASE_URL"; exit 1 ;;
esac
case "$DATABASE_URL" in
  */sentrello_dev*)
    echo "  refusing to run tests against sentrello_dev — that is the browser"
    echo "  instance, and its organization would be destroyed."
    exit 1 ;;
  */sentrello)
    echo "  refusing to run tests against the shared sentrello database."
    echo "  It is retired: every repository now has its own. Unset DATABASE_URL"
    echo "  to use this one's, or name the database you meant."
    exit 1 ;;
esac
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
  local url="$DATABASE_URL"
  printf '  %-12s ' "leftovers"
  command -v psql >/dev/null || { echo "skipped (no psql)"; return; }

  local left
  left="$(psql "$url" -tAc 'select count(*) from organizations' 2>/dev/null)" || {
    echo "skipped (no database)"
    return
  }

  # One statement, built from the catalogue, existence-shaped: on a clean run
  # every branch scans an empty table and the whole thing is a few
  # milliseconds. Measured at 27ms against a database holding 200k rows.
  local generator parts due
  generator="select coalesce(string_agg(format(
      'select %L as t, count(*) as n from %I.%I x
         where x.%I is not null
           and not exists (select 1 from public.organizations o
                            where o.id = x.organization_id)',
      n.nspname || '.' || c.relname, n.nspname, c.relname, a.attname),
    ' union all '), 'select null::text as t, 0::bigint as n')
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
    join pg_namespace n on n.oid = c.relnamespace
    where a.attnum > 0 and not a.attisdropped
      and n.nspname not in ('pg_catalog', 'information_schema')
      and (a.attname like 'next\_%\_at'
           or a.attname in ('due_at', 'due_date', 'send_at', 'scheduled_at',
                            'starts_at', 'run_at', 'retry_at', 'process_at'))
      and exists (select 1 from pg_attribute w
                   where w.attrelid = c.oid and w.attname = 'organization_id'
                     and w.attnum > 0 and not w.attisdropped)"
  parts="$(psql "$url" -tAc "$generator" 2>/dev/null)"
  due=""
  [ -n "$parts" ] && due="$(psql "$url" -tA -F'  ' -c \
    "select t, n from ($parts) z where n > 0 order by n desc, t" 2>/dev/null)"

  if [ "$left" = "0" ] && [ -z "$due" ]; then
    echo "ok"
    return
  fi
  echo "FAILED"
  failed=1

  if [ "$left" != "0" ]; then
    echo "      $left organization(s) left in the test database:"
    # Named, so whoever reads this knows which suite to look at rather than
    # having to open a database client to find out.
    psql "$url" -tA -F'  ' -c \
      'select id, name from organizations order by created_at limit 10' \
      2>/dev/null | sed 's/^/        /'
    echo "      A suite did not clean up. Remove them by id — never with an"
    echo "      unscoped delete, which has been run against a shared database"
    echo "      once already on the strength of a line like this one:"
    echo "        psql \"$url\" -c \"delete from organizations where id = '...'\""
  fi

  if [ -n "$due" ]; then
    echo "      work still scheduled in an organization that no longer exists:"
    # The table names the module, which names the suite.
    printf '%s\n' "$due" | sed 's/^/        /'
    echo "      Every sweep in the platform selects what is due across all"
    echo "      organizations, so these are rows another suite's run will pick"
    echo "      up and count. Either the suite that made them does not clean"
    echo "      up, or a delete path leaves its children behind."
  fi
}
# Before the tests as well as after: a database that starts dirty makes the
# run's own leftovers unreadable, and the suites are not worth the minutes if
# the answer at the end cannot be trusted. It says nothing about being ready —
# that word belongs after the tests have run, and printing it here is how a
# commit went in on the strength of a line the tests had not reached yet.
step_leftovers

if [ "$failed" -ne 0 ]; then
  printf '\n  not ready to commit\n'
  exit 1
fi

step "tests" bun test
step_leftovers

if [ "$failed" -ne 0 ]; then
  printf '\n  not ready to commit\n'
  exit 1
fi
printf '\n  ready\n'
