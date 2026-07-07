# AGENTS.md

## Project Shape
- This repo is a standalone pi leader-mode extension, not a full app. Load it with `pi -e ~/Projects/pi-ultra/src/extension.ts`.
- `src/extension.ts` is the extension entrypoint and default export; `src/index.ts` only re-exports library APIs.
- Subagents are persistent RPC child processes launched by `src/rpc-process.ts` with `pi --mode rpc`; set `PI_LEADER_PI_BIN` when `pi` is not on `PATH`.

## Commands
- Install dependencies with `pnpm install` to respect `pnpm-lock.yaml`. The README's `npm install --ignore-scripts` is older than the lockfile.
- There are no configured `package.json` scripts, tsconfig, lint, formatter, test runner, or CI workflows in this repo.
- Runtime dependencies from the lockfile require Node `>=22.19.0`.

## Implementation Notes
- Keep TypeScript ESM imports explicit with `.ts` extensions, matching the existing source files.
- Leader mode intentionally restricts active tools to `spawn_subagent`, `send_to_subagent`, `merge_subagent_worktree`, and `list_available_models` in `src/extension.ts`.
- The leader is event-driven: subagent `agent_end`/exit events enqueue one `leader:subagent_update` message with `triggerTurn: true`; do not add polling/status tools unless behavior changes intentionally.
- Worktree-backed subagents create git worktrees via `git worktree add <path> -b <branch>` and merge with `git checkout <target>` then `git merge --no-ff <branch>` in the repo root.
- Temporary worktrees are created under the OS temp dir at `pi-leader-worktrees` and removed on subagent stop/shutdown.

## Verification
- With no test or typecheck script, focused verification is usually loading the extension in pi and exercising `/leader`, `/leader status`, and a small subagent spawn.
- For RPC behavior, verify the `pi` binary can run `pi --mode rpc` from the target cwd before debugging extension code.
