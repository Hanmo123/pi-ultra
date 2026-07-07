import type { AgentSessionEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagent, type Subagent } from "./subagent.ts";
import type { ModelChoice, SubagentRecord } from "./types.ts";
import { createWorktree, mergeBranch, removeWorktree } from "./worktree.ts";

export interface SubagentUpdateDetail {
	id: string;
	label?: string;
	status: SubagentRecord["status"];
	lastAssistantText?: string;
}

function formatSubagentUpdate(updates: SubagentUpdateDetail[]): string {
	const lines = updates.map((update) => {
		const title = update.label ? `${update.id} (${update.label})` : update.id;
		const summary = update.lastAssistantText?.trim() || "(no assistant output)";
		return `- ${title}: ${summary}`;
	});
	return `Subagent update:\n${lines.join("\n")}`;
}

export class SubagentManager {
	protected readonly pi: ExtensionAPI;
	private readonly subagents = new Map<string, Subagent>();
	private readonly pendingUpdates = new Map<string, SubagentUpdateDetail>();
	private flushScheduled = false;
	private nextId = 1;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) {
			return;
		}
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			void this.flushPendingUpdates();
		});
	}

	private async flushPendingUpdates(): Promise<void> {
		if (this.pendingUpdates.size === 0) {
			return;
		}
		const updates = [...this.pendingUpdates.values()];
		this.pendingUpdates.clear();
		for (const update of updates) {
			this.subagents.get(update.id)?.setPendingReactivation(false);
		}
		this.pi.sendMessage(
			{
				customType: "leader:subagent_update",
				content: formatSubagentUpdate(updates),
				details: { updates },
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	private enqueueUpdate(update: SubagentUpdateDetail): void {
		this.pendingUpdates.set(update.id, update);
		this.subagents.get(update.id)?.setPendingReactivation(true);
		this.scheduleFlush();
	}

	private buildUpdate(record: SubagentRecord): SubagentUpdateDetail {
		return {
			id: record.id,
			label: record.label,
			status: record.status,
			lastAssistantText: record.lastAssistantText,
		};
	}

	private handleSubagentEvent = async (subagent: Subagent, event: AgentSessionEvent): Promise<void> => {
		if (event.type !== "agent_end") {
			return;
		}
		await subagent.syncState();
		const record = subagent.getRecord();
		this.enqueueUpdate(this.buildUpdate(record));
	};

	private handleSubagentExit = (subagent: Subagent): void => {
		const record = subagent.getRecord();
		this.enqueueUpdate(this.buildUpdate(record));
	};

	private createId(label?: string): string {
		if (label) {
			const normalized = label
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "");
			if (normalized) {
				const base = normalized;
				let candidate = base;
				let suffix = 2;
				while (this.subagents.has(candidate)) {
					candidate = `${base}-${suffix}`;
					suffix++;
				}
				return candidate;
			}
		}
		let candidate = `subagent-${this.nextId}`;
		this.nextId++;
		while (this.subagents.has(candidate)) {
			candidate = `subagent-${this.nextId}`;
			this.nextId++;
		}
		return candidate;
	}

	async spawn(options: {
		task: string;
		branch: string;
		cwd: string;
		label?: string;
		model?: ModelChoice;
	}): Promise<SubagentRecord> {
		const id = this.createId(options.label);
		const worktree = await createWorktree({
			cwd: options.cwd,
			branch: options.branch,
		});
		const subagent = createSubagent({
			id,
			cwd: worktree.path,
			label: options.label,
			worktree,
		});
		this.subagents.set(id, subagent);
		subagent.onEvent((event) => {
			void this.handleSubagentEvent(subagent, event);
		});
		subagent.onExit(() => {
			this.handleSubagentExit(subagent);
		});
		await subagent.initialize(options.model);
		await subagent.prompt(options.task);
		return subagent.getRecord();
	}

	async send(id: string, message: string, mode: "prompt" | "steer" | "followUp" = "prompt"): Promise<SubagentRecord> {
		const subagent = this.subagents.get(id);
		if (!subagent) {
			throw new Error(`Unknown subagent: ${id}`);
		}
		if (mode === "steer") {
			await subagent.steer(message);
		} else if (mode === "followUp") {
			await subagent.followUp(message);
		} else {
			await subagent.prompt(message);
		}
		return subagent.getRecord();
	}

	list(): SubagentRecord[] {
		return [...this.subagents.values()].map((subagent) => subagent.getRecord());
	}

	async get(id: string): Promise<SubagentRecord> {
		const subagent = this.subagents.get(id);
		if (!subagent) {
			throw new Error(`Unknown subagent: ${id}`);
		}
		await subagent.syncState();
		return subagent.getRecord();
	}

	async stop(id: string): Promise<SubagentRecord> {
		const subagent = this.subagents.get(id);
		if (!subagent) {
			throw new Error(`Unknown subagent: ${id}`);
		}
		await subagent.abort();
		await subagent.dispose();
		this.subagents.delete(id);
		const record = subagent.getRecord();
		if (record.worktree) {
			await removeWorktree(record.worktree);
		}
		return record;
	}

	async merge(
		id: string,
		into?: string,
		strategy?: "merge" | "squash",
	): Promise<{
		record: SubagentRecord;
		merged: boolean;
		stdout: string;
		stderr: string;
		conflictedFiles: string[];
	}> {
		const record = await this.get(id);
		if (!record.worktree) {
			throw new Error(`Subagent ${id} has no worktree branch to merge`);
		}
		const result = await mergeBranch({ cwd: record.worktree.repoRoot, branch: record.worktree.branch, into, strategy });
		return {
			record,
			merged: result.merged,
			stdout: result.stdout,
			stderr: result.stderr,
			conflictedFiles: result.conflictedFiles,
		};
	}

	async shutdown(): Promise<void> {
		for (const [id, subagent] of this.subagents) {
			const record = subagent.getRecord();
			await subagent.dispose();
			this.subagents.delete(id);
			if (record.worktree) {
				await removeWorktree(record.worktree);
			}
		}
		this.pendingUpdates.clear();
	}
}
