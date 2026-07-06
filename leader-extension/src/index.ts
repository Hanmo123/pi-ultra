export { createLeaderExtension, default as leaderExtension, type LeaderExtensionOptions } from "./extension.ts";
export { LEADER_SYSTEM_PROMPT } from "./prompt.ts";
export { createSubagent, Subagent } from "./subagent.ts";
export { SubagentManager, type SubagentUpdateDetail, type WaitCondition } from "./subagent-manager.ts";
export {
	createGetSubagentOutputTool,
	createListAvailableModelsTool,
	createListSubagentsTool,
	createMergeSubagentWorktreeTool,
	createSendToSubagentTool,
	createSpawnSubagentTool,
	createStopSubagentTool,
	createWaitTool,
} from "./tools.ts";
export type { ModelChoice, SubagentRecord, SubagentStatus } from "./types.ts";
export {
	createWorktree,
	findRepoRoot,
	type MergeResult,
	mergeBranch,
	removeWorktree,
	type WorktreeRecord,
} from "./worktree.ts";
