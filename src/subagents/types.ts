import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.ts";

export type { ThinkingLevel };

export type SubagentType = string;
export type MemoryScope = "user" | "project" | "local";

export interface AgentConfig {
	name: string;
	displayName?: string;
	description: string;
	builtinToolNames?: string[];
	extSelectors?: string[];
	disallowedTools?: string[];
	extensions: true | string[] | false;
	excludeExtensions?: string[];
	skills: true | string[] | false;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	persistSession?: boolean;
	sessionDir?: string;
	systemPrompt: string;
	promptMode: "replace" | "append";
	inheritContext?: boolean;
	runInBackground?: boolean;
	isolated?: boolean;
	memory?: MemoryScope;
	isDefault?: boolean;
	enabled?: boolean;
	source?: "default" | "project" | "global";
}

export interface AgentRecord {
	id: string;
	type: SubagentType;
	description: string;
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
	result?: string;
	error?: string;
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	session?: AgentSession;
	abortController?: AbortController;
	promise?: Promise<string>;
	resultConsumed?: boolean;
	pendingSteers?: string[];
	worktree?: { path: string; branch: string; baseSha: string; workPath: string };
	worktreeResult?: { hasChanges: boolean; branch?: string };
	lifetimeUsage: LifetimeUsage;
	compactionCount: number;
	isBackground?: boolean;
}

export interface EnvInfo {
	isGitRepo: boolean;
	branch: string;
	platform: string;
}
