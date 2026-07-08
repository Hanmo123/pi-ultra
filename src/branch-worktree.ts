import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export interface BranchWorktreeInfo {
	path: string;
	branch: string;
	baseSha: string;
	workPath: string;
}

export interface BranchWorktreeCleanupResult {
	hasChanges: boolean;
	branch?: string;
	path?: string;
	error?: string;
}

function removeWorktree(cwd: string, worktreePath: string): void {
	try {
		execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
			cwd,
			stdio: "pipe",
			timeout: 10000,
		});
	} catch {
		try {
			execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
		} catch {
			// Best effort cleanup only.
		}
	}
}

function deleteBranch(cwd: string, branch: string): void {
	try {
		execFileSync("git", ["branch", "-D", branch], { cwd, stdio: "pipe", timeout: 5000 });
	} catch {
		// A missing or already-removed branch is harmless here.
	}
}

function currentBranch(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
			cwd,
			stdio: "pipe",
			timeout: 5000,
		}).toString().trim();
	} catch {
		return undefined;
	}
}

export function createBranchWorktree(cwd: string, idHint = randomUUID().slice(0, 17)): BranchWorktreeInfo | undefined {
	let baseSha: string;
	let subdir: string;
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
		baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 }).toString().trim();
		const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 }).toString().trim();
		subdir = relative(realpathSync(topLevel), realpathSync(cwd));
	} catch {
		return undefined;
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		const suffix = randomUUID().slice(0, 8);
		const branch = `pi-agent-${idHint}-${suffix}`;
		const worktreePath = join(tmpdir(), `pi-agent-${idHint}-${suffix}`);
		try {
			execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
				cwd,
				stdio: "pipe",
				timeout: 30000,
			});
			if (currentBranch(worktreePath) !== branch) {
				removeWorktree(cwd, worktreePath);
				deleteBranch(cwd, branch);
				continue;
			}
			return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
		} catch {
			removeWorktree(cwd, worktreePath);
			deleteBranch(cwd, branch);
		}
	}

	return undefined;
}

export function cleanupBranchWorktree(cwd: string, worktree: BranchWorktreeInfo, agentDescription: string): BranchWorktreeCleanupResult {
	if (!existsSync(worktree.path)) {
		return { hasChanges: false };
	}

	try {
		const branch = currentBranch(worktree.path);
		if (branch !== worktree.branch) {
			return {
				hasChanges: true,
				branch: worktree.branch,
				path: worktree.path,
				error: `Worktree is not on expected branch ${worktree.branch}; current branch is ${branch ?? "DETACHED HEAD"}`,
			};
		}

		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd: worktree.path,
			stdio: "pipe",
			timeout: 10000,
		}).toString().trim();

		if (status) {
			execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
			const commitMsg = `pi-agent: ${agentDescription.slice(0, 200)}`;
			execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
				cwd: worktree.path,
				stdio: "pipe",
				timeout: 10000,
			});
		}

		const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: worktree.path,
			stdio: "pipe",
			timeout: 5000,
		}).toString().trim();

		if (currentSha === worktree.baseSha) {
			removeWorktree(cwd, worktree.path);
			deleteBranch(cwd, worktree.branch);
			return { hasChanges: false };
		}

		removeWorktree(cwd, worktree.path);
		return {
			hasChanges: true,
			branch: worktree.branch,
			path: worktree.path,
		};
	} catch (error) {
		return {
			hasChanges: true,
			branch: worktree.branch,
			path: worktree.path,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
