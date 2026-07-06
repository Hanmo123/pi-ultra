# Leader Extension

A standalone pi extension that adds leader mode.

## Usage

Install dependencies in this directory:

```bash
npm install --ignore-scripts
```

Load the extension from pi:

```bash
pi -e ~/Projects/pi-ultra/leader-extension/src/extension.ts
```

Then use:

- `/leader`
- `/leader on`
- `/leader off`
- `/leader status`
- `/leader <goal>`

Leader mode exposes only orchestration tools by default and can spawn persistent RPC subagents, including optional git worktree-backed subagents.

The leader is event-driven: after delegating work, it waits to be reactivated automatically when a subagent finishes or exits with an error. It does not need polling tools or an explicit stop tool to check status.

Notes:

- The extension starts subagents by invoking `pi --mode rpc`.
- If `pi` is not on your `PATH`, set `PI_LEADER_PI_BIN` to the full path of the `pi` executable before launching.
