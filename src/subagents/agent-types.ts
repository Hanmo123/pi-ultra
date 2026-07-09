import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import type { AgentConfig } from "./types.ts";

export const BUILTIN_TOOL_NAMES: string[] = [
	...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((tool) => tool.name)),
];

const agents = new Map<string, AgentConfig>();

export function registerAgents(userAgents: Map<string, AgentConfig>): void {
	agents.clear();
	for (const [name, config] of DEFAULT_AGENTS) {
		agents.set(name, config);
	}
	for (const [name, config] of userAgents) {
		agents.set(name, config);
	}
}

function resolveKey(name: string): string | undefined {
	if (agents.has(name)) {
		return name;
	}
	const lower = name.toLowerCase();
	for (const key of agents.keys()) {
		if (key.toLowerCase() === lower) {
			return key;
		}
	}
	return undefined;
}

export function resolveType(name: string): string | undefined {
	return resolveKey(name);
}

export function getAgentConfig(name: string): AgentConfig | undefined {
	const key = resolveKey(name);
	return key ? agents.get(key) : undefined;
}

export function getToolNamesForType(type: string): string[] {
	const key = resolveKey(type);
	const raw = key ? agents.get(key) : undefined;
	const config = raw?.enabled !== false ? raw : undefined;
	return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

export function getConfig(type: string): {
	displayName: string;
	description: string;
	builtinToolNames: string[];
	extensions: true | string[] | false;
	excludeExtensions?: string[];
	skills: true | string[] | false;
	promptMode: "replace" | "append";
} {
	const key = resolveKey(type);
	const config = key ? agents.get(key) : undefined;
	if (config && config.enabled !== false) {
		return {
			displayName: config.displayName ?? config.name,
			description: config.description,
			builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: config.extensions,
			excludeExtensions: config.excludeExtensions,
			skills: config.skills,
			promptMode: config.promptMode,
		};
	}

	const fallback = agents.get("general-purpose");
	if (fallback && fallback.enabled !== false) {
		return {
			displayName: fallback.displayName ?? fallback.name,
			description: fallback.description,
			builtinToolNames: fallback.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: fallback.extensions,
			excludeExtensions: fallback.excludeExtensions,
			skills: fallback.skills,
			promptMode: fallback.promptMode,
		};
	}

	return {
		displayName: "Agent",
		description: "General-purpose agent for complex, multi-step tasks",
		builtinToolNames: BUILTIN_TOOL_NAMES,
		extensions: true,
		skills: true,
		promptMode: "append",
	};
}

const MEMORY_TOOL_NAMES = ["read", "write", "edit"];
const READONLY_MEMORY_TOOL_NAMES = ["read"];

export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
	return MEMORY_TOOL_NAMES.filter((name) => !existingToolNames.has(name));
}

export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
	return READONLY_MEMORY_TOOL_NAMES.filter((name) => !existingToolNames.has(name));
}
