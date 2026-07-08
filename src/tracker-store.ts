import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { TrackerBranchRecord, TrackerCommentRecord, TrackerRecord } from "./types.ts";

const TRACKER_VERSION = 1;
const execFileAsync = promisify(execFile);

function nowIso(): string {
	return new Date().toISOString();
}

function slugify(input: string, fallback: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || fallback;
}

function trackerId(title: string): string {
	const compactTime = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/u, "");
	return `trk-${compactTime}-${slugify(title, "issue")}-${randomUUID().slice(0, 6)}`;
}

function repoDirectoryName(cwd: string): string {
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
	return `${slugify(basename(cwd), "repo")}-${hash}`;
}

function branchFileName(branch: string): string {
	return `${encodeURIComponent(branch).replace(/%/g, "~")}.md`;
}

function branchTitle(branch: string): string {
	return branch.replace(/\r?\n/g, " ").trim() || "unknown-branch";
}

async function projectRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
		return stdout.trim() || cwd;
	} catch {
		return realpath(cwd).catch(() => cwd);
	}
}

function trackerMarkdown(record: TrackerRecord): string {
	const branches = Object.values(record.branches)
		.sort((a, b) => a.branch.localeCompare(b.branch))
		.map((branch) => `- ${branch.branch}: ${branch.comments.length} comment(s), updated ${branch.updatedAt}`)
		.join("\n") || "- No branch comments yet.";

	return [
		`# ${record.title}`,
		"",
		`Tracker: ${record.id}`,
		`Repository: ${record.repoPath}`,
		`Created: ${record.createdAt}`,
		`Updated: ${record.updatedAt}`,
		"",
		record.description ? `## Description\n\n${record.description}` : "## Description\n\n(No description.)",
		"",
		"## Branches",
		"",
		branches,
		"",
	].join("\n");
}

function branchMarkdown(record: TrackerRecord, branch: TrackerBranchRecord): string {
	const comments = branch.comments.map((comment) => {
		const lines = [
			`## ${comment.createdAt} - ${comment.author}`,
			"",
			comment.status ? `Status: ${comment.status}` : undefined,
			comment.subagentId ? `Subagent: ${comment.subagentId}` : undefined,
			comment.worktreePath ? `Worktree: ${comment.worktreePath}` : undefined,
			"",
			comment.body.trim() || "(No content.)",
			"",
		].filter((line): line is string => line !== undefined);
		return lines.join("\n");
	}).join("\n");

	return [
		`# ${record.title}`,
		"",
		`Tracker: ${record.id}`,
		`Branch: ${branch.branch}`,
		`Updated: ${branch.updatedAt}`,
		"",
		comments || "No comments yet.",
	].join("\n");
}

export class TrackerStore {
	private readonly baseDir: string;

	constructor(baseDir = join(homedir(), "pi-worktrees")) {
		this.baseDir = baseDir;
	}

	async getProjectDir(cwd: string): Promise<string> {
		const resolved = await projectRoot(cwd);
		return join(this.baseDir, repoDirectoryName(resolved), "trackers");
	}

	private async trackerDir(cwd: string, id: string): Promise<string> {
		return join(await this.getProjectDir(cwd), id);
	}

	private async indexPath(cwd: string, id: string): Promise<string> {
		return join(await this.trackerDir(cwd, id), "index.json");
	}

	private async read(cwd: string, id: string): Promise<TrackerRecord> {
		const content = await readFile(await this.indexPath(cwd, id), "utf8");
		return JSON.parse(content) as TrackerRecord;
	}

	private async write(cwd: string, record: TrackerRecord): Promise<TrackerRecord> {
		const dir = await this.trackerDir(cwd, record.id);
		await mkdir(join(dir, "branches"), { recursive: true });
		await writeFile(join(dir, "index.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
		await writeFile(join(dir, "tracker.md"), trackerMarkdown(record), "utf8");
		for (const branch of Object.values(record.branches)) {
			await writeFile(join(dir, "branches", branchFileName(branch.branch)), branchMarkdown(record, branch), "utf8");
		}
		return record;
	}

	async create(cwd: string, options: { title: string; description?: string }): Promise<TrackerRecord> {
		const repoPath = await projectRoot(cwd);
		const createdAt = nowIso();
		const id = trackerId(options.title);
		const record: TrackerRecord = {
			version: TRACKER_VERSION,
			id,
			title: options.title.trim() || "Untitled tracker",
			description: options.description?.trim() || undefined,
			repoPath,
			path: await this.trackerDir(cwd, id),
			createdAt,
			updatedAt: createdAt,
			branches: {},
		};
		return this.write(cwd, record);
	}

	async list(cwd: string): Promise<TrackerRecord[]> {
		const root = await this.getProjectDir(cwd);
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		const records = await Promise.all(entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				try {
					const content = await readFile(join(root, entry.name, "index.json"), "utf8");
					return JSON.parse(content) as TrackerRecord;
				} catch {
					return undefined;
				}
			}));
		return records
			.filter((record): record is TrackerRecord => record !== undefined)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async get(cwd: string, id: string): Promise<TrackerRecord> {
		return this.read(cwd, id);
	}

	async appendComment(cwd: string, id: string, options: {
		branch: string;
		author: string;
		body: string;
		subagentId?: string;
		status?: string;
		worktreePath?: string;
	}): Promise<{ record: TrackerRecord; comment: TrackerCommentRecord; branchPath: string }> {
		const record = await this.read(cwd, id);
		const createdAt = nowIso();
		const branchName = branchTitle(options.branch);
		const branch = record.branches[branchName] ?? {
			branch: branchName,
			createdAt,
			updatedAt: createdAt,
			comments: [],
		};
		const comment: TrackerCommentRecord = {
			id: `cmt-${createdAt.replace(/[-:.]/g, "")}`,
			createdAt,
			author: options.author,
			body: options.body,
			subagentId: options.subagentId,
			status: options.status,
			worktreePath: options.worktreePath,
		};
		branch.comments.push(comment);
		branch.updatedAt = createdAt;
		record.branches[branchName] = branch;
		record.updatedAt = createdAt;
		await this.write(cwd, record);
		return {
			record,
			comment,
			branchPath: join(await this.trackerDir(cwd, id), "branches", branchFileName(branch.branch)),
		};
	}

	async readMarkdown(cwd: string, id: string): Promise<{ record: TrackerRecord; markdown: string; trackerPath: string }> {
		const record = await this.read(cwd, id);
		const trackerPath = join(await this.trackerDir(cwd, id), "tracker.md");
		const branchSections = Object.values(record.branches)
			.sort((a, b) => a.branch.localeCompare(b.branch))
			.map((branch) => branchMarkdown(record, branch))
			.join("\n\n---\n\n");
		return {
			record,
			trackerPath,
			markdown: [trackerMarkdown(record), branchSections].filter(Boolean).join("\n---\n\n"),
		};
	}
}
