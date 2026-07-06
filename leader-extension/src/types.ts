import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { WorktreeRecord } from "./worktree.ts";

export type SubagentStatus = "starting" | "idle" | "working" | "error" | "stopped";

export interface ModelChoice {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface SubagentRecord {
	id: string;
	createdAt: string;
	cwd: string;
	label?: string;
	lastAssistantText?: string;
	model?: ModelChoice;
	pendingReactivation: boolean;
	status: SubagentStatus;
	worktree?: WorktreeRecord;
}
