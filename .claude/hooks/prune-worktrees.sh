#!/usr/bin/env bash
# Removes finished subagent worktrees (.claude/worktrees/agent-*) and their
# leftover worktree-agent-* branches. Runs from the SessionStart hook.
#
# Claude Code sweeps these too, but only after cleanupPeriodDays, which also
# governs transcripts. This keeps them for a few days instead of a month.
#
# A worktree goes only when nothing can be lost: no uncommitted or untracked
# files, no ignored files beyond rebuildable output, every commit on origin,
# no process running inside it, and no activity for KEEP_DAYS.
#
# Usage: prune-worktrees.sh [--dry-run]
# Env:   TENZO_WORKTREE_KEEP_DAYS (default 3)
set -u

keep_days="${TENZO_WORKTREE_KEEP_DAYS:-3}"
dry_run=""
[ "${1:-}" = "--dry-run" ] && dry_run=1

# git status must not refresh the index: that would count as activity.
export GIT_OPTIONAL_LOCKS=0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
root="$(dirname "$common")/.claude/worktrees"
log="$common/prune-worktrees.log"
[ -d "$root" ] || exit 0

# Concurrent sessions: one sweep at a time. A lock left by a killed sweep expires.
lock="$common/prune-worktrees.lock"
find "$lock" -maxdepth 0 -mmin +60 -exec rmdir {} \; 2>/dev/null
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock"' EXIT

# Without this list we can't tell what's in use, so do nothing.
cwds="$(lsof -nP -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
[ -n "$cwds" ] || exit 0

all_on_origin() { [ -z "$(git -C "$1" rev-list -n 1 "$2" --not --remotes=origin 2>/dev/null)" ]; }

report() {
  if [ -n "$dry_run" ]; then echo "would $*"; else echo "$(date '+%F %T') $*" >>"$log"; fi
}

for dir in "$root"/agent-*; do
  [ -d "$dir" ] || continue
  dir="$(cd "$dir" && pwd -P)"
  admin="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)" || continue

  # Pinned by hand, or a live session or process inside it.
  [ -e "$admin/locked" ] && continue
  printf '%s\n' "$cwds" | grep -Fq "$dir" && continue

  # Recent commits, checkouts or top-level changes.
  [ -z "$(find "$dir" "$admin/HEAD" "$admin/logs/HEAD" -maxdepth 0 -mtime "-$keep_days" 2>/dev/null)" ] || continue

  # Anything uncommitted, plus ignored files that a build can't bring back.
  [ -z "$(git -C "$dir" status --porcelain --ignored 2>/dev/null |
    grep -vE '^!! (.*/)?(node_modules|dist|build|\.svelte-kit|\.turbo)/$|^!! (.*/)?\.DS_Store$')" ] || continue

  all_on_origin "$dir" HEAD || continue

  head="$(git -C "$dir" rev-parse --short HEAD)"
  if [ -n "$dry_run" ]; then
    report "remove worktree $(basename "$dir") ($head)"
  # No --force: git still refuses locked or dirty worktrees.
  elif git -C "$common" worktree remove "$dir" 2>/dev/null; then
    report "removed worktree $(basename "$dir") ($head)"
  fi
done

git -C "$common" worktree prune

# Branches git can't delete because a worktree still has them checked out stay.
git -C "$common" for-each-ref --format='%(refname:short)' 'refs/heads/worktree-agent-*' |
  while read -r branch; do
    all_on_origin "$common" "$branch" || continue
    if [ -n "$dry_run" ]; then
      report "delete branch $branch unless a kept worktree uses it"
    elif git -C "$common" branch -D "$branch" >/dev/null 2>&1; then
      report "deleted branch $branch"
    fi
  done

exit 0
