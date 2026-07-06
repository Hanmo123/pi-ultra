import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface WorktreeRecord {
	branch: string;
	repoRoot: string;
	path: string;
}

export interface MergeResult {
	branch: string;
	into: string;
	merged: boolean;
	stdout: string;
	stderr: string;
	conflictedFiles: string[];
}

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

function execGit(args: string[], cwd: string): Promise<ExecResult> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (!error) {
				resolvePromise({ code: 0, stdout, stderr });
				return;
			}
			const code = typeof error.code === "number" ? error.code : 1;
			if (code > 1) {
				reject(new Error(stderr || stdout || String(error.message)));
				return;
			}
			resolvePromise({ code, stdout, stderr });
		});
	});
}

export async function findRepoRoot(cwd: string): Promise<string> {
	const result = await execGit(["rev-parse", "--show-toplevel"], cwd);
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `Not a git repository: ${cwd}`);
	}
	return result.stdout.trim();
}

export function createWorktreeDir(repoRoot: string, branch: string): string {
	const baseDir = join(tmpdir(), "pi-leader-worktrees", randomUUID());
	mkdirSync(baseDir, { recursive: true });
	return join(baseDir, `${repoRoot.split("/").pop() || "repo"}-${branch}`);
}

export async function createWorktree(options: { cwd: string; branch: string; path?: string }): Promise<WorktreeRecord> {
	const repoRoot = await findRepoRoot(options.cwd);
	const worktreePath = resolve(options.path ?? createWorktreeDir(repoRoot, options.branch));
	const result = await execGit(["worktree", "add", worktreePath, "-b", options.branch], repoRoot);
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `Failed to create worktree for ${options.branch}`);
	}
	return {
		branch: options.branch,
		repoRoot,
		path: worktreePath,
	};
}

export async function removeWorktree(record: WorktreeRecord): Promise<void> {
	const result = await execGit(["worktree", "remove", record.path, "--force"], record.repoRoot);
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `Failed to remove worktree ${record.path}`);
	}
	if (record.path.startsWith(join(tmpdir(), "pi-leader-worktrees"))) {
		try {
			rmSync(record.path, { recursive: true, force: true });
		} catch {
			// ignore cleanup error after git worktree remove
		}
	}
}

export async function mergeBranch(options: { cwd: string; branch: string; into?: string }): Promise<MergeResult> {
	const repoRoot = await findRepoRoot(options.cwd);
	const target = options.into ?? (await execGit(["branch", "--show-current"], repoRoot)).stdout.trim();
	if (!target) {
		throw new Error("Unable to resolve merge target branch");
	}
	const switchResult = await execGit(["checkout", target], repoRoot);
	if (switchResult.code !== 0) {
		throw new Error(switchResult.stderr || switchResult.stdout || `Failed to checkout ${target}`);
	}
	const mergeResult = await execGit(["merge", "--no-ff", options.branch], repoRoot);
	if (mergeResult.code === 0) {
		return {
			branch: options.branch,
			into: target,
			merged: true,
			stdout: mergeResult.stdout,
			stderr: mergeResult.stderr,
			conflictedFiles: [],
		};
	}
	const conflicts = await execGit(["diff", "--name-only", "--diff-filter=U"], repoRoot);
	return {
		branch: options.branch,
		into: target,
		merged: false,
		stdout: mergeResult.stdout,
		stderr: mergeResult.stderr,
		conflictedFiles: conflicts.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	};
}
