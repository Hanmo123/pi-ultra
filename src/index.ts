export { createLeaderExtension, default as leaderExtension, type LeaderExtensionOptions } from "./extension.ts";
export { LEADER_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "./prompt.ts";
export { SubagentManager, type SubagentUpdateDetail } from "./subagent-manager.ts";
export {
	createListAvailableModelsTool,
	createSendToSubagentTool,
	createSpawnSubagentTool,
} from "./tools.ts";
export type { ModelChoice, SubagentRecord, SubagentStatus, WorktreeRecord, WorktreeResult } from "./types.ts";
