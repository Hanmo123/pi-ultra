import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.ts";

export function preloadSkills(skillNames: string[], cwd: string): { name: string; content: string }[] {
	return skillNames.map((name) => ({ name, content: loadSkillContent(name, cwd) }));
}

function loadSkillContent(name: string, cwd: string): string {
	if (isUnsafeName(name)) {
		return `(Skill "${name}" skipped: name contains path traversal characters)`;
	}

	const roots = [
		join(cwd, ".pi", "skills"),
		join(cwd, ".agents", "skills"),
		join(getAgentDir(), "skills"),
		join(homedir(), ".agents", "skills"),
		join(homedir(), ".pi", "skills"),
	];

	for (const root of roots) {
		const content = findInRoot(root, name);
		if (content !== undefined) {
			return content;
		}
	}

	return `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;
}

function findInRoot(root: string, name: string): string | undefined {
	if (isSymlink(root)) {
		return undefined;
	}
	const flat = safeReadFile(join(root, `${name}.md`))?.trim();
	if (flat !== undefined) {
		return flat;
	}
	return findSkillDirectory(root, name);
}

function findSkillDirectory(root: string, name: string): string | undefined {
	if (!existsSync(root)) {
		return undefined;
	}
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			continue;
		}
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
				continue;
			}
			const path = join(current, entry.name);
			const skillMd = join(path, "SKILL.md");
			if (existsSync(skillMd)) {
				if (entry.name === name) {
					return safeReadFile(skillMd)?.trim();
				}
				continue;
			}
			queue.push(path);
		}
	}
	return undefined;
}
