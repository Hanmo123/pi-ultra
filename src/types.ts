import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type SubagentStatus = "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";

export interface ModelChoice {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface WorktreeRecord {
	branch: string;
	path: string;
	baseSha?: string;
	workPath?: string;
}

export interface WorktreeResult {
	hasChanges: boolean;
	branch?: string;
}

export interface SubagentRecord {
	id: string;
	createdAt: string;
	cwd: string;
	description: string;
	label?: string;
	lastAssistantText?: string;
	model?: ModelChoice;
	result?: string;
	error?: string;
	status: SubagentStatus;
	subagentType: string;
	worktree?: WorktreeRecord;
	worktreeResult?: WorktreeResult;
}
