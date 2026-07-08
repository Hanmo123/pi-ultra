export { createLeaderExtension, default as leaderExtension, type LeaderExtensionOptions } from "./extension.ts";
export { LEADER_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "./prompt.ts";
export { SubagentManager, type SubagentUpdateDetail } from "./subagent-manager.ts";
export { TrackerStore } from "./tracker-store.ts";
export {
	createCommentTrackerTool,
	createCreateTrackerTool,
	createListAvailableModelsTool,
	createListTrackersTool,
	createReadTrackerTool,
	createSendToSubagentTool,
	createSpawnSubagentTool,
} from "./tools.ts";
export type {
	ModelChoice,
	SubagentRecord,
	SubagentStatus,
	TrackerBranchRecord,
	TrackerCommentRecord,
	TrackerRecord,
	WorktreeRecord,
	WorktreeResult,
} from "./types.ts";
