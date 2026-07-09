import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryScope } from "./types.ts";

const MAX_MEMORY_LINES = 200;

export function isUnsafeName(name: string): boolean {
	return !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

export function isSymlink(filePath: string): boolean {
	try {
		return lstatSync(filePath).isSymbolicLink();
	} catch {
		return false;
	}
}

export function safeReadFile(filePath: string): string | undefined {
	if (!existsSync(filePath) || isSymlink(filePath)) {
		return undefined;
	}
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
	if (isUnsafeName(agentName)) {
		throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
	}
	switch (scope) {
		case "user":
			return join(homedir(), ".pi", "agent-memory", agentName);
		case "project":
			return join(cwd, ".pi", "agent-memory", agentName);
		case "local":
			return join(cwd, ".pi", "agent-memory-local", agentName);
	}
}

function readMemoryIndex(memoryDir: string): string | undefined {
	if (isSymlink(memoryDir)) {
		return undefined;
	}
	const content = safeReadFile(join(memoryDir, "MEMORY.md"));
	if (content === undefined) {
		return undefined;
	}
	const lines = content.split("\n");
	if (lines.length > MAX_MEMORY_LINES) {
		return `${lines.slice(0, MAX_MEMORY_LINES).join("\n")}\n... (truncated at 200 lines)`;
	}
	return content;
}

export function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
	const memoryDir = resolveMemoryDir(agentName, scope, cwd);
	if (existsSync(memoryDir)) {
		if (isSymlink(memoryDir)) {
			throw new Error(`Refusing to use symlinked memory directory: ${memoryDir}`);
		}
	} else {
		mkdirSync(memoryDir, { recursive: true });
	}

	const existingMemory = readMemoryIndex(memoryDir);
	const memoryContent = existingMemory
		? `\n\n## Current MEMORY.md\n${existingMemory}`
		: `\n\nNo MEMORY.md exists yet. Create one at ${join(memoryDir, "MEMORY.md")} to start building persistent memory.`;

	return `# Agent Memory

You have a persistent memory directory at: ${memoryDir}/
Memory scope: ${scope}

This memory persists across sessions. Use it to build up knowledge over time.${memoryContent}

## Memory Instructions
- MEMORY.md is an index file. Keep it concise, under 200 lines.
- Store detailed memories in separate files within ${memoryDir}/ and link to them from MEMORY.md.
- Update or remove memories that become outdated. Check for existing memories before creating duplicates.
- You have Read, Write, and Edit tools available for managing memory files.`;
}

export function buildReadOnlyMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
	const memoryDir = resolveMemoryDir(agentName, scope, cwd);
	const existingMemory = readMemoryIndex(memoryDir);
	const memoryContent = existingMemory
		? `\n\n## Current MEMORY.md\n${existingMemory}`
		: "\n\nNo memory is available yet. Other agents or sessions with write access can create memories for you to consume.";

	return `# Agent Memory (read-only)

Memory scope: ${scope}
You have read-only access to memory. You can reference existing memories but cannot create or modify them.${memoryContent}`;
}
