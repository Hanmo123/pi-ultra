import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.ts";
import type { AgentConfig, MemoryScope, ThinkingLevel } from "./types.ts";

export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
	const agents = new Map<string, AgentConfig>();
	loadFromDir(join(getAgentDir(), "agents"), agents, "global");
	loadFromDir(join(cwd, ".pi", "agents"), agents, "project");
	return agents;
}

function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "global" | "project"): void {
	if (!existsSync(dir)) {
		return;
	}
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".md"));
	} catch {
		return;
	}

	for (const file of files) {
		const name = basename(file, ".md");
		let content: string;
		try {
			content = readFileSync(join(dir, file), "utf8");
		} catch {
			continue;
		}
		const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);
		const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);
		agents.set(name, {
			name,
			displayName: str(fm.display_name),
			description: str(fm.description) ?? name,
			builtinToolNames,
			extSelectors,
			disallowedTools: csvListOptional(fm.disallowed_tools),
			extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
			excludeExtensions: csvListOptional(fm.exclude_extensions),
			skills: inheritField(fm.skills ?? fm.inherit_skills),
			model: str(fm.model),
			thinking: parseThinking(fm.thinking),
			maxTurns: nonNegativeInt(fm.max_turns),
			persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
			sessionDir: str(fm.session_dir),
			systemPrompt: body.trim(),
			promptMode: fm.prompt_mode === "append" ? "append" : "replace",
			inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
			runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
			isolated: fm.isolated != null ? fm.isolated === true : undefined,
			memory: parseMemory(fm.memory),
			enabled: fm.enabled !== false,
			source,
		});
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && value >= 0 ? value : undefined;
}

function parseCsvField(value: unknown): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const text = String(value).trim();
	if (!text || text === "none") {
		return undefined;
	}
	const items = text.split(",").map((item) => item.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function csvList(value: unknown, defaults: string[]): string[] {
	if (value === undefined || value === null) {
		return defaults;
	}
	return parseCsvField(value) ?? [];
}

function csvListOptional(value: unknown): string[] | undefined {
	return parseCsvField(value);
}

function parseToolsField(value: unknown): { builtinToolNames: string[]; extSelectors?: string[] } {
	const entries = csvList(value, BUILTIN_TOOL_NAMES);
	const isWildcard = (entry: string) => entry === "*" || entry.toLowerCase() === "all";
	const hasWildcard = entries.some(isWildcard);
	const plain = entries.filter((entry) => !isWildcard(entry) && !entry.startsWith("ext:"));
	const extEntries = entries.filter((entry) => entry.startsWith("ext:"));
	return {
		builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
		extSelectors: extEntries.length > 0 ? extEntries : undefined,
	};
}

function inheritField(value: unknown): true | string[] | false {
	if (value === undefined || value === null || value === true) {
		return true;
	}
	if (value === false || value === "none") {
		return false;
	}
	const items = csvList(value, []);
	return items.length > 0 ? items : false;
}

function parseMemory(value: unknown): MemoryScope | undefined {
	return value === "user" || value === "project" || value === "local" ? value : undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" ? value as ThinkingLevel : undefined;
}
