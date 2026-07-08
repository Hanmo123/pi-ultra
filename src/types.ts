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

export interface TrackerCommentRecord {
	id: string;
	createdAt: string;
	author: string;
	body: string;
	subagentId?: string;
	status?: string;
	worktreePath?: string;
}

export interface TrackerBranchRecord {
	branch: string;
	createdAt: string;
	updatedAt: string;
	comments: TrackerCommentRecord[];
}

export interface TrackerRecord {
	version: number;
	id: string;
	title: string;
	description?: string;
	repoPath: string;
	path: string;
	createdAt: string;
	updatedAt: string;
	branches: Record<string, TrackerBranchRecord>;
}

export interface SubagentRecord {
	id: string;
	createdAt: string;
	cwd: string;
	description: string;
	label?: string;
	trackerId?: string;
	model?: ModelChoice;
	result?: string;
	error?: string;
	status: SubagentStatus;
	subagentType: string;
	worktree?: WorktreeRecord;
	worktreeResult?: WorktreeResult;
}
