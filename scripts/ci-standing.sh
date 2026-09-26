#!/usr/bin/env bash
# Where the default branch's own checks stand, asked before adding to it.
#
# On 25 September CI went red and stayed red for four pushes before anybody
# looked. Nothing was broken by the fourth push that was not broken by the
# first; what was lost was the hour between them, and the signal — a red run
# under three more red runs says nothing about which commit did it.
#
# Required status checks do not help here. They are evaluated when a pull
# request merges, and this project pushes straight to main; a check that only
# runs on a merge never runs at all. So the question is asked at the one
# moment that is both cheap and unavoidable: the push itself.
#
# It refuses rather than warns. A warning in a pre-push hook is read once and
# scrolled past for ever after, which is the failure this is written against.
#
#   Push anyway:  SENTRELLO_PUSH_ANYWAY=1 git push
#
# Silent and successful whenever it cannot answer — no `gh`, no network, not
# signed in, a repository with no runs yet. A guard that blocks a push because
# a laptop is on a train is a guard that gets deleted.
set -uo pipefail

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
[ -n "$default" ] || default="main"

# Only the branch everything is cut from. A topic branch may be red; that is
# what a topic branch is for.
[ "$branch" = "$default" ] || exit 0
[ "${SENTRELLO_PUSH_ANYWAY:-}" = "1" ] && exit 0
command -v gh >/dev/null 2>&1 || exit 0

# The newest run that has finished. One in flight says nothing yet, and
# waiting for it would put a ten-minute pause in front of every push.
latest="$(
  gh run list --branch "$default" --status completed --limit 1 \
    --json conclusion,workflowName,headSha,url \
    --jq '.[0] | "\(.conclusion)\t\(.workflowName)\t\(.headSha[0:7])\t\(.url)"' \
    2>/dev/null
)" || exit 0
[ -n "$latest" ] || exit 0

IFS=$'\t' read -r conclusion workflow sha url <<<"$latest"

case "$conclusion" in
  success | skipped | cancelled | neutral) exit 0 ;;
esac

# `%s` on a `printf` with colour, rather than `echo -e`, because the hook runs
# under whatever shell git hands it.
printf '\033[31m%s\033[0m\n' "pre-push: $default is red, and this push would stack on it."
printf '  %s\n' "$workflow on $sha finished: $conclusion"
printf '  %s\n' "$url"
printf '%s\n' ""
printf '%s\n' "Fix it, or push anyway and say why out loud:"
printf '%s\n' "    SENTRELLO_PUSH_ANYWAY=1 git push"
exit 1
