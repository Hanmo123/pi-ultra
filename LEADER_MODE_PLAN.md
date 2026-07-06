# Pi Leader Mode — Execution Plan

## 1. Goal

Add a **leader mode** to pi. A leader is a pi agent that:

- Decomposes a task and dispatches an arbitrary number of **subagents** to explore, code, and test.
- Chooses which model each subagent uses.
- Does **not** do the final task execution itself. It only: dispatches subagents, aggregates their returned data, makes further decisions, and dispatches more subagents / messages as needed.
- After dispatching, the leader **parks** (stops taking action). When *any* subagent responds, the leader is **reactivated** and decides: continue (dispatch more, or message a specific subagent) or take no action (wait for other subagents before deciding together).
- The **user can message the leader at any time**. The leader then decides: dispatch subagents in parallel, message a specific subagent now, or wait for a specific subagent to finish before messaging it.
- **Future**: leader dispatches subagents into **git worktree** directories for parallel multi-agent work, and finally merges the git branches itself.

## 2. Architecture Decision

Reuse the existing infrastructure rather than build a new process manager:

- `packages/orchestrator` already spawns `pi --mode rpc` child processes (`RpcProcessInstance`), streams all agent events over JSONL, bridges extension UI requests, and manages instance lifecycle (`OrchestratorSupervisor`, IPC socket via `serve`). `SpawnRequest` already carries unused `provider`/`model` fields.
- **RPC mode** exposes the full command surface a leader needs to drive a subagent: `prompt`, `steer`, `follow_up`, `set_model`, `get_state`, `get_last_assistant_text`, `abort`, `new_session`, plus a complete streaming event feed (`agent_start/agent_end/turn_end/...`).
- **Extensions** can register LLM-callable tools and, critically, inject messages back into their *own* session with `pi.sendMessage(..., { deliverAs, triggerTurn })` / `pi.sendUserMessage(...)`. This is the exact mechanism to **reactivate a parked leader** when a subagent event arrives.
- **Interactive mode** already lets a human type into the session at any time (steer / follow-up / idle prompt). So "the user can message the leader anytime" comes for free when the leader is a normal interactive pi session with the leader extension loaded.

**Chosen design: the leader is a normal pi session (interactive or SDK-driven) plus a `leader` extension.** The extension:

1. Registers leader tools the LLM calls to drive subagents (`spawn_subagent`, `send_to_subagent`, `wait`, `list_subagents`, `get_subagent_output`, `stop_subagent`, and later `merge_worktrees`).
2. Owns a `SubagentManager` that wraps `RpcProcessInstance` (one child `pi --mode rpc` per subagent), tracks state, and subscribes to each subagent's event stream.
3. When a subagent reaches an interesting state (e.g., `agent_end`), the manager calls `pi.sendMessage({ customType: "leader:subagent_update", ... }, { deliverAs: "steer" | "followUp", triggerTurn: true })` to reactivate the parked leader with the subagent's result.
4. The leader's system prompt (a leader skill / prompt override) instructs it to only orchestrate, never execute directly.

This keeps the leader loop model-driven and reuses pi's queueing semantics: the leader parks by simply ending its turn (no pending tool calls); it reactivates when the extension injects a message.

### Why not a bespoke event loop
pi's agent loop + steering/follow-up queue already models "park until a message arrives, then decide." Building the leader as a model driving tools, reactivated by injected messages, means "leader decision-making" is just the LLM responding to injected subagent updates — no custom scheduler needed. Concurrency across subagents is handled by the async `RpcProcessInstance` children; the manager serializes reactivations through pi's queue so the leader processes one decision cycle at a time.

## 3. Package / File Layout

New package `packages/leader` (mirrors `orchestrator` conventions) OR extend `orchestrator`. Decision: **new package `packages/leader`** that depends on `@earendil-works/pi-coding-agent` and reuses `RpcProcessInstance` from `@earendil-works/pi-orchestrator` (add it as a dependency). Rationale: orchestrator is machine/instance-registry oriented (persistent socket, radius presence); leader mode is per-session, ephemeral, and tool-driven. Keeping it separate avoids coupling the leader lifecycle to the orchestrator daemon.

```
packages/leader/
  package.json
  tsconfig.build.json
  README.md
  src/
    index.ts
    types.ts              # SubagentRecord, SubagentStatus, LeaderConfig, ModelChoice
    subagent.ts           # Subagent wrapper over RpcProcessInstance (spawn, prompt, events, dispose)
    subagent-manager.ts   # SubagentManager: registry, event fan-in, reactivation bridge
    tools.ts              # defineTool factories for spawn/send/wait/list/get/stop
    extension.ts          # default ExtensionAPI factory: registers tools + wires manager reactivation
    prompt.ts             # leader system prompt / guidelines text
    worktree.ts           # (phase 4) git worktree create/list/remove/merge helpers
  test/
    subagent-manager.test.ts
    tools.test.ts
    extension.test.ts     # uses coding-agent test harness + faux provider
```

Also add a leader **skill** or **prompt template** (`packages/leader` ships a skill dir, or install into `.pi/skills/leader/`) so a normal `pi` session can enter leader mode via `/skill:leader` or a dedicated launch flag.

## 4. Core Types (draft)

```ts
type SubagentStatus = "starting" | "idle" | "working" | "error" | "stopped";

interface ModelChoice { provider: string; modelId: string; thinkingLevel?: ThinkingLevel; }

interface SubagentRecord {
  id: string;              // short handle, e.g. "explorer-1"
  label?: string;
  cwd: string;             // subagent working dir (worktree in phase 4)
  model?: ModelChoice;
  status: SubagentStatus;
  lastAssistantText?: string;
  pendingReactivation: boolean;
  createdAt: string;
}
```

## 5. Leader Tools (LLM-callable)

- `spawn_subagent({ label?, task, model?, cwd?, waitForResult? })` — spawns a child, sets its model via `set_model`, sends the task as a `prompt`. Returns the subagent id immediately (parking model) or the result if `waitForResult`. Default: return id and let leader park.
- `send_to_subagent({ id, message, mode?: "steer" | "followUp" | "prompt" })` — routes a message to a running/idle subagent. `steer` interrupts mid-run; `prompt`/`followUp` used when idle or to enqueue.
- `list_subagents()` — returns all records with status + last result summary.
- `get_subagent_output({ id, full? })` — returns last assistant text (or full transcript via `get_messages`).
- `wait({ ids?, mode?: "any" | "all" })` — explicit park: tells the leader to take no action until the named subagents (or any/all) report. Implemented by having the tool return a marker and the manager only reactivate per the wait condition.
- `stop_subagent({ id })` — abort + dispose the child.
- (phase 4) `merge_worktrees({ ids | branches, into })` — merge subagent branches.

Each tool has `promptGuidelines` naming the tool explicitly (per AGENTS.md rule).

## 6. Reactivation Bridge (the heart)

- `SubagentManager` subscribes to each `RpcProcessInstance.onEvent`.
- On `agent_end` (subagent finished a turn) it records `lastAssistantText` (via `get_last_assistant_text`), sets status `idle`, and if the leader is currently parked, injects:
  `pi.sendMessage({ customType: "leader:subagent_update", content: "<id> finished: <summary>", display: true, details: {...} }, { deliverAs: leaderStreaming ? "steer" : "followUp", triggerTurn: true })`.
- `wait` semantics: manager holds a wait-condition. Reactivation for "all" batches updates until every awaited subagent is idle, then injects one consolidated message. For "any" (default), injects on first update.
- Guard against reactivation storms: coalesce multiple simultaneous `agent_end`s into a single injected update when the leader is mid-decision.
- User messages: handled natively by interactive/RPC mode. No extra work — the leader's normal input path already lets the user steer/prompt. The system prompt tells the leader how to react to user input vs subagent updates (distinguishable by `customType`).

## 7. Model Selection Per Subagent

- `spawn_subagent`'s `model` param accepts `provider/modelId[:thinking]`. Manager, after spawn, sends RPC `set_model` (+ `set_thinking_level`). If omitted, subagent inherits leader default or first available. Expose `get_available_models` to the leader via a tool or include the list in the system prompt at session start.

## 8. Git Worktree Support (Phase 4)

- `worktree.ts`: `createWorktree(repoRoot, branch)` → `git worktree add <dir> -b <branch>`; `removeWorktree(dir)`; `listWorktrees()`; `mergeBranch(branch, into)`.
- `spawn_subagent({ worktree: true, branch? })` creates a worktree dir and spawns the subagent with `cwd` = worktree path, so each subagent edits an isolated checkout. Multiple subagents run truly in parallel without file collisions.
- Leader `merge_worktrees` merges branches back (fast-forward or merge commit), reports conflicts to the leader for a decision (possibly dispatching a "conflict-resolver" subagent).
- Respect AGENTS.md git rules: explicit paths, no `-A`, no destructive resets. Worktrees give isolation so this is naturally satisfied.

## 9. Entry Points

1. **As an extension in interactive mode**: `pi -e packages/leader/src/extension.ts` (dev) or install into `~/.pi/agent/extensions/`. User talks to the leader in the normal TUI; the leader spawns subagents under the hood.
2. **Leader skill/prompt**: ship a skill that sets the orchestration system prompt; `/skill:leader "<goal>"` kicks off.
3. **(optional) SDK launcher**: a small `createLeaderSession()` helper wrapping `createAgentSession` with the leader extension + prompt, for programmatic use.

Start with (1) for fastest iteration; (2) and (3) layer on top.

## 10. Testing Strategy

- Unit: `SubagentManager` with a mocked `RpcProcessInstance` (event injection, reactivation, wait modes, coalescing).
- Tools: parameter validation, routing, error paths.
- Integration: coding-agent `test/suite/harness.ts` + faux provider to drive a leader session that spawns a fake subagent (subagent also faux) and verify the leader parks/reactivates. No real provider APIs (AGENTS.md).
- Follow AGENTS.md: run `./test.sh` for non-e2e; `npm run check` after code changes; erasable-TS only; deps pinned.

## 11. Milestones & Commit Points

Each milestone ends with a scoped commit (`feat(leader): ...`), staging only leader-package files (plus any minimal orchestrator export change).

- **M0 — Scaffold**: create `packages/leader` (package.json, tsconfig, empty index, README, wire into root build order + workspaces). Export `RpcProcessInstance` publicly from orchestrator if not already usable. `npm run check`. *Commit.*
- **M1 — Subagent wrapper**: `subagent.ts` over `RpcProcessInstance` (spawn, set model, prompt, event subscribe, get last text, dispose) + unit test with mock. *Commit.*
- **M2 — Manager + reactivation**: `subagent-manager.ts` with registry, event fan-in, `pi.sendMessage` reactivation bridge, `wait` modes, coalescing + tests. *Commit.*
- **M3 — Tools + extension + prompt**: `tools.ts`, `extension.ts`, `prompt.ts`; loadable via `-e`; integration test with faux provider. *Commit.*
- **M4 — Leader skill / launch UX**: ship leader skill/prompt; document usage; optional `createLeaderSession` SDK helper. *Commit.*
- **M5 — Git worktree**: `worktree.ts`, `spawn_subagent({ worktree })`, `merge_worktrees`, conflict-report path + tests. *Commit.*
- **M6 — Docs & polish**: README, docs page, examples; final `npm run check` + `./test.sh`. *Commit.*

## 12. Open Questions / Risks

- **Reactivation while leader is mid-turn**: rely on pi's steer/follow-up queue; verify ordering with faux-provider tests. Coalescing prevents storms.
- **Nested pi processes / resource use**: each subagent is a full `pi --mode rpc` process. Cap concurrency (config `maxSubagents`) and always dispose on leader session shutdown (`session_shutdown` handler).
- **Auth/model availability in child**: children inherit env; ensure API keys resolve. Validate `set_model` failures surface to the leader as a subagent error update.
- **Cost/observability**: aggregate subagent token/cost via `get_session_stats`; surface in `list_subagents`.
- **Whether to fold into `orchestrator`**: revisit after M2 if the split causes duplication; keep the seam narrow (only depend on `RpcProcessInstance`).
```
