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

# The newest run that has finished, **of a workflow that tests something**.
# One in flight says nothing yet, and waiting for it would put a ten-minute
# pause in front of every push.
#
# `red-main` is excluded, and that is the whole of this filter. It is the
# notifier — it watches CI and opens or closes an issue — so its conclusion
# is a statement about GitHub's API, not about the code. On 27 September it
# ran with `RESULT: success`, went to close the issue, got a GraphQL error
# doing it, and failed. CI itself was green. Every push to this repository
# was then refused as "main is red" by a job that had just finished saying
# main was fine.
#
# A few runs rather than one, because the notifier fires after each CI run
# and would otherwise usually be the newest thing there is.
latest="$(
  gh run list --branch "$default" --status completed --limit 10 \
    --json conclusion,workflowName,headSha,url \
    --jq '[.[] | select(.workflowName != "red-main")][0]
          | "\(.conclusion)\t\(.workflowName)\t\(.headSha[0:7])\t\(.url)"' \
    2>/dev/null
)" || exit 0
[ "$latest" = "null" ] && exit 0
[ -n "$latest" ] || exit 0

IFS=$'\t' read -r conclusion workflow sha url <<<"$latest"

# Unless something newer has already been pushed, in which case the red one is
# not the standing of this branch — it is the standing of a commit somebody has
# already moved past.
#
# The check above reads the newest *finished* run on purpose, because waiting for
# one in flight would put ten minutes in front of every push. The cost of that
# choice showed up on 5 October: a red run, a fix pushed straight after it, and
# then every push refused for the whole length of the fix's own run — naming a sha
# that was no longer the tip. Three commits sat on a laptop with nothing wrong
# with them.
#
# So: if any run exists for a commit *later* than the red one, the red one has
# been answered. In flight or finished, because the question here is only whether
# somebody has already moved on, and `git merge-base` answers it from the sha
# rather than from the run's state.
newest_sha="$(
  gh run list --branch "$default" --limit 10 \
    --json workflowName,headSha \
    --jq '[.[] | select(.workflowName != "red-main")][0].headSha' \
    2>/dev/null
)" || newest_sha=""
if [ -n "$newest_sha" ] && [ "$newest_sha" != "null" ] &&
   [ "${newest_sha:0:7}" != "$sha" ] &&
   git merge-base --is-ancestor "$sha" "$newest_sha" 2>/dev/null; then
  exit 0
fi

# A repository with no runs at all answers `null` in every field rather than
# a bare `null`, because the interpolation happens per field — so the check
# above sees "null\tnull\tnull\tnull", which is neither empty nor "null",
# and the guard refuses a push it has nothing to say about.
#
# Found the first time a repository was pushed to from empty, which is the
# one case the comment at the top of this file promises is silent. A guard
# that blocks a push because there is nothing to report is the failure this
# was written against, in its own words.
case "$conclusion" in
  "" | null | success | skipped | cancelled | neutral) exit 0 ;;
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
