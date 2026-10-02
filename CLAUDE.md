# Tenzo

An attention queue for coding agents. Read `docs/PRODUCT.md` first: it holds the decisions, the opinions Tenzo enforces, and the MVP scope. Treat it as settled unless the user reopens something.

## Reference implementation

T3 Code is the architectural reference. A clone lives at `../reference/t3code` (outside this repo). `docs/REFERENCE.md` maps each Tenzo concern to the T3 file that already solves it. Read the T3 code for a concern before designing it from scratch; then build the smaller version. Don't copy Effect, the relay, or IDE features.

## Working style

- Design questions: one at a time, with a recommended answer.
- Tenzo must never reduce what Claude Code or Codex can do. Threads run the real binaries with the user's own config (subagents, skills, hooks, MCP, plugins).
- Tenzo knows nothing about issue trackers, specs, or skills. Those belong to the agent and its prompts.
- Keep it light: a feature that can be a prompt should be a prompt.

## How to continue

1. `docs/ROADMAP.md` is the plan; GitHub issues are the tasks. Take the lowest-numbered open issue whose blockers are closed. Read its latest comment first: it holds the handoff state.
2. A slice is done when its acceptance criteria are demonstrably met, `pnpm check` is green, `docs/ROADMAP.md` has its box ticked, and the commit message says `Closes #N`.
3. Commit and push after every slice. Don't ask for permission to build, test, commit or push; the repo's `.claude/settings.json` allows it. Ask only before anything destructive.
4. Work from the repo docs, not from memory of earlier sessions; a new session may run in a different worktree.

## Stack (see PRODUCT.md §10)

pnpm monorepo. `apps/daemon` (Node 22+, TypeScript, node:sqlite, Hono + ws), `apps/web` (Svelte 5, SvelteKit static, Tailwind v4), `packages/contracts` (zod), `packages/client-runtime` (framework-free).
