import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentRecord as PiSubagentRecord } from "@tintinweb/pi-subagents/dist/types.js";
import {
	cleanupBranchWorktree,
	createBranchWorktree,
	type BranchWorktreeCleanupResult,
	type BranchWorktreeInfo,
} from "./branch-worktree.ts";
import { LEADER_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "./prompt.ts";
import { TrackerStore } from "./tracker-store.ts";
import type { ModelChoice, SubagentRecord, TrackerRecord } from "./types.ts";

const require = createRequire(import.meta.url);
const { AgentManager: PiSubagentsAgentManager } = require("@tintinweb/pi-subagents/dist/agent-manager.js") as typeof import("@tintinweb/pi-subagents/dist/agent-manager.js");
const { DEFAULT_AGENTS } = require("@tintinweb/pi-subagents/dist/default-agents.js") as typeof import("@tintinweb/pi-subagents/dist/default-agents.js");
const { getAgentConfig, registerAgents, resolveType } = require("@tintinweb/pi-subagents/dist/agent-types.js") as typeof import("@tintinweb/pi-subagents/dist/agent-types.js");
const { loadCustomAgents } = require("@tintinweb/pi-subagents/dist/custom-agents.js") as typeof import("@tintinweb/pi-subagents/dist/custom-agents.js");
const { resolveModel } = require("@tintinweb/pi-subagents/dist/model-resolver.js") as typeof import("@tintinweb/pi-subagents/dist/model-resolver.js");

export interface SubagentUpdateDetail {
	id: string;
	label?: string;
	status: SubagentRecord["status"];
	branch?: string;
	trackerId?: string;
	trackerPath?: string;
	branchPath?: string;
	error?: string;
}

const DEFAULT_SUBAGENT_TYPE = "general-purpose";
function stripLeaderPrompt(systemPrompt: string): string {
	const suffix = `\n\n${LEADER_SYSTEM_PROMPT}`;
	if (systemPrompt.endsWith(suffix)) {
		return systemPrompt.slice(0, -suffix.length).trimEnd();
	}
	return systemPrompt.replace(LEADER_SYSTEM_PROMPT, "").trim();
}

function summarizeTask(task: string): string {
	const singleLine = task.replace(/\s+/g, " ").trim();
	if (!singleLine) {
		return "Delegated task";
	}
	if (singleLine.length <= 72) {
		return singleLine;
	}
	return `${singleLine.slice(0, 69).trimEnd()}...`;
}

function formatSubagentUpdate(updates: SubagentUpdateDetail[]): string {
	const lines = updates.map((update) => {
		const title = update.label ? `${update.id} (${update.label})` : update.id;
		const tracker = update.trackerId ? ` tracker=${update.trackerId}` : "";
		const branch = update.branch ? ` branch=${update.branch}` : "";
		const path = update.branchPath ? ` file=${update.branchPath}` : "";
		const error = update.error ? ` archive_error=${update.error}` : "";
		return `- ${title} [${update.status}]${tracker}${branch}${path}${error}`;
	});
	return `Tracker update:\n${lines.join("\n")}\nUse read_tracker to inspect subagent results.`;
}

export class SubagentManager {
	protected readonly pi: ExtensionAPI;
	private readonly manager: PiSubagentsAgentManager;
	private readonly trackerStore: TrackerStore;
	private readonly leaderExtensionNames: string[];
	private readonly metadata = new Map<
		string,
		{
			cwd: string;
			description: string;
			label?: string;
			model?: ModelChoice;
			trackerId: string;
			worktree: BranchWorktreeInfo;
			worktreeResult?: BranchWorktreeCleanupResult;
		}
	>();
	private readonly pendingUpdates = new Map<string, SubagentUpdateDetail>();
	private flushScheduled = false;

	constructor(pi: ExtensionAPI, options: { leaderExtensionNames: string[]; trackerStore?: TrackerStore }) {
		this.pi = pi;
		this.leaderExtensionNames = options.leaderExtensionNames;
		this.trackerStore = options.trackerStore ?? new TrackerStore();
		this.manager = new PiSubagentsAgentManager((record) => {
			void this.handleSubagentComplete(record);
		});
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
		this.pi.sendMessage(
			{
				customType: "leader:tracker_update",
				content: formatSubagentUpdate(updates),
				details: { updates },
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	private enqueueUpdate(update: SubagentUpdateDetail): void {
		this.pendingUpdates.set(update.id, update);
		this.scheduleFlush();
	}

	private buildLeaderSafeConfig(config: AgentConfig, parentSystemPrompt: string): AgentConfig {
		const excludeExtensions = new Set(config.excludeExtensions ?? []);
		for (const leaderExtensionName of this.leaderExtensionNames) {
			excludeExtensions.add(leaderExtensionName);
		}

		const inheritedPrompt = config.promptMode === "append"
			? [stripLeaderPrompt(parentSystemPrompt), config.systemPrompt.trim()].filter(Boolean).join("\n\n")
			: config.systemPrompt.trim();

		return {
			...config,
			excludeExtensions: [...excludeExtensions],
			promptMode: "replace",
			systemPrompt: [inheritedPrompt, SUBAGENT_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
		};
	}

	private reloadAgentTypes(projectCwd: string, parentSystemPrompt: string): void {
		const agents = new Map<string, AgentConfig>();
		for (const [name, config] of DEFAULT_AGENTS) {
			agents.set(name, this.buildLeaderSafeConfig(config, parentSystemPrompt));
		}
		for (const [name, config] of loadCustomAgents(projectCwd)) {
			agents.set(name, this.buildLeaderSafeConfig(config, parentSystemPrompt));
		}
		registerAgents(agents);
	}

	private modelChoiceToString(model: ModelChoice | undefined): string | undefined {
		if (!model) {
			return undefined;
		}
		return `${model.provider}/${model.modelId}`;
	}

	private mapRecord(record: PiSubagentRecord): SubagentRecord {
		const metadata = this.metadata.get(record.id);
		const localWorktree = metadata?.worktree;
		const localResult = metadata?.worktreeResult;
		const packageWorktree = record.worktree;
		const packageResult = record.worktreeResult;
		const branch = localResult?.branch ?? packageResult?.branch ?? localWorktree?.branch ?? packageWorktree?.branch;
		const worktree = localWorktree ?? packageWorktree;
		const worktreeResult = localResult ?? packageResult;
		return {
			id: record.id,
			createdAt: new Date(record.startedAt).toISOString(),
			cwd: metadata?.cwd ?? worktree?.workPath ?? worktree?.path ?? "",
			description: metadata?.description ?? record.description,
			label: metadata?.label,
			trackerId: metadata?.trackerId,
			model: metadata?.model,
			result: record.result,
			error: record.error,
			status: record.status,
			subagentType: record.type,
			worktree: worktree
				? {
					branch: branch ?? worktree.branch,
					path: worktree.path,
					baseSha: worktree.baseSha,
					workPath: worktree.workPath,
				}
				: undefined,
			worktreeResult: worktreeResult
				? {
					hasChanges: worktreeResult.hasChanges,
					branch: worktreeResult.branch,
				}
				: undefined,
		};
	}

	private cleanupManagedWorktree(record: PiSubagentRecord): BranchWorktreeCleanupResult | undefined {
		const metadata = this.metadata.get(record.id);
		if (!metadata?.worktree) {
			return undefined;
		}
		if (metadata.worktreeResult) {
			return metadata.worktreeResult;
		}

		const result = cleanupBranchWorktree(metadata.cwd, metadata.worktree, metadata.description);
		metadata.worktreeResult = result;
		if (result.hasChanges && result.branch && !result.error) {
			record.result = `${record.result ?? ""}\n\n---\nChanges saved to branch \`${result.branch}\` in \`${metadata.cwd}\`. Merge with: \`git merge ${result.branch}\` (run in \`${metadata.cwd}\`).`.trim();
		}
		if (result.error) {
			record.result = `${record.result ?? ""}\n\n---\nWorktree cleanup warning: ${result.error}\nWorktree path: ${result.path ?? metadata.worktree.path}`.trim();
		}
		return result;
	}

	private buildUpdate(record: SubagentRecord, archive?: { trackerPath?: string; branchPath?: string; error?: string }): SubagentUpdateDetail {
		return {
			id: record.id,
			label: record.label,
			status: record.status,
			branch: record.worktreeResult?.branch ?? record.worktree?.branch,
			trackerId: record.trackerId,
			trackerPath: archive?.trackerPath,
			branchPath: archive?.branchPath,
			error: archive?.error,
		};
	}

	private async handleSubagentComplete(record: PiSubagentRecord): Promise<void> {
		this.cleanupManagedWorktree(record);
		const mapped = this.mapRecord(record);
		let archive: { trackerPath?: string; branchPath?: string; error?: string } | undefined;
		if (mapped.trackerId) {
			try {
				const branch = mapped.worktreeResult?.branch ?? mapped.worktree?.branch ?? "no-saved-branch";
				const body = record.result?.trim() || record.error?.trim() || "(No subagent result.)";
				const archived = await this.trackerStore.appendComment(mapped.cwd, mapped.trackerId, {
					branch,
					author: `subagent:${record.id}`,
					body,
					subagentId: record.id,
					status: record.status,
					worktreePath: mapped.worktree?.path,
				});
				archive = { trackerPath: archived.record.path, branchPath: archived.branchPath };
			} catch (error) {
				archive = { error: error instanceof Error ? error.message : String(error) };
			}
		}
		this.enqueueUpdate(this.buildUpdate(mapped, archive));
	}

	private requireRecord(id: string): PiSubagentRecord {
		const record = this.manager.getRecord(id);
		if (!record) {
			throw new Error(`Unknown subagent: ${id}`);
		}
		return record;
	}

	async spawn(options: {
		ctx: ExtensionContext;
		task: string;
		cwd: string;
		label?: string;
		model?: ModelChoice;
		subagentType?: string;
		trackerId?: string;
	}): Promise<SubagentRecord> {
		this.reloadAgentTypes(options.ctx.cwd, options.ctx.getSystemPrompt());

		const requestedType = options.subagentType?.trim() || DEFAULT_SUBAGENT_TYPE;
		const subagentType = resolveType(requestedType) ?? DEFAULT_SUBAGENT_TYPE;
		const agentConfig = getAgentConfig(subagentType);
		const modelInput = agentConfig?.model ?? this.modelChoiceToString(options.model);
		const modelFromParams = agentConfig?.model == null && modelInput != null;

		let model: ReturnType<typeof resolveModel> | undefined;
		if (modelInput) {
			const resolvedModel = resolveModel(modelInput, options.ctx.modelRegistry);
			if (typeof resolvedModel === "string") {
				if (modelFromParams) {
					throw new Error(resolvedModel);
				}
			} else {
				model = resolvedModel;
			}
		}

		const description = options.label?.trim() || summarizeTask(options.task);
		const tracker = options.trackerId
			? await this.trackerStore.get(options.cwd, options.trackerId)
			: await this.trackerStore.create(options.cwd, { title: description, description: options.task });
		const worktree = createBranchWorktree(options.cwd);
		if (!worktree) {
			throw new Error('Cannot run with isolation: "worktree" - failed to create a branch-backed git worktree. Initialize git and commit at least once, or fix git worktree creation.');
		}

		let id: string;
		try {
			id = this.manager.spawn(this.pi, options.ctx, subagentType, options.task, {
				description,
				cwd: worktree.workPath,
				model,
				maxTurns: agentConfig?.maxTurns,
				isolated: agentConfig?.isolated ?? false,
				inheritContext: agentConfig?.inheritContext ?? false,
				thinkingLevel: agentConfig?.thinking ?? options.model?.thinkingLevel,
				isBackground: true,
				isolation: undefined,
			});
		} catch (error) {
			cleanupBranchWorktree(options.cwd, worktree, description);
			throw error;
		}

		this.metadata.set(id, {
			cwd: options.cwd,
			description,
			label: options.label?.trim() || undefined,
			model: options.model,
			trackerId: tracker.id,
			worktree,
		});

		return this.mapRecord(this.requireRecord(id));
	}

	async send(id: string, message: string, mode: "prompt" | "steer" | "followUp" = "prompt"): Promise<SubagentRecord> {
		const record = this.requireRecord(id);
		if (record.status === "queued" || record.status === "running") {
			if (!this.manager.steer(id, message)) {
				throw new Error(`Subagent ${id} is not available for steering`);
			}
			return this.mapRecord(this.requireRecord(id));
		}
		if (mode === "steer") {
			throw new Error(`Subagent ${id} is not running; current status is ${record.status}`);
		}
		const resumed = await this.manager.resume(id, message);
		if (!resumed) {
			throw new Error(`Subagent ${id} cannot be resumed`);
		}
		return this.mapRecord(resumed);
	}

	list(): SubagentRecord[] {
		return this.manager.listAgents().map((record) => this.mapRecord(record));
	}

	async get(id: string): Promise<SubagentRecord> {
		return this.mapRecord(this.requireRecord(id));
	}

	async createTracker(cwd: string, title: string, description?: string): Promise<TrackerRecord> {
		return this.trackerStore.create(cwd, { title, description });
	}

	async listTrackers(cwd: string): Promise<TrackerRecord[]> {
		return this.trackerStore.list(cwd);
	}

	async readTracker(cwd: string, id: string): Promise<{ record: TrackerRecord; markdown: string; trackerPath: string }> {
		return this.trackerStore.readMarkdown(cwd, id);
	}

	async commentTracker(cwd: string, id: string, branch: string, body: string): Promise<{ record: TrackerRecord; branchPath: string }> {
		const result = await this.trackerStore.appendComment(cwd, id, {
			branch,
			author: "leader",
			body,
		});
		return { record: result.record, branchPath: result.branchPath };
	}

	async stop(id: string): Promise<SubagentRecord> {
		if (!this.manager.abort(id)) {
			throw new Error(`Unknown subagent: ${id}`);
		}
		const record = this.requireRecord(id);
		if (!record.promise) {
			this.cleanupManagedWorktree(record);
		}
		return this.mapRecord(record);
	}

	async shutdown(): Promise<void> {
		this.manager.abortAll();
		for (const record of this.manager.listAgents()) {
			this.cleanupManagedWorktree(record);
		}
		this.manager.dispose();
		this.metadata.clear();
		this.pendingUpdates.clear();
	}
}
