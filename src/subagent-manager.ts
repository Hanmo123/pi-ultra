import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cleanupBranchWorktree,
	createBranchWorktree,
	type BranchWorktreeCleanupResult,
	type BranchWorktreeInfo,
} from "./branch-worktree.ts";
import { LEADER_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "./prompt.ts";
import { AgentManager } from "./subagents/agent-manager.ts";
import { getAgentConfig, registerAgents, resolveType } from "./subagents/agent-types.ts";
import { loadCustomAgents } from "./subagents/custom-agents.ts";
import { DEFAULT_AGENTS } from "./subagents/default-agents.ts";
import { resolveModel } from "./subagents/model-resolver.ts";
import type { AgentConfig, AgentRecord as InternalAgentRecord } from "./subagents/types.ts";
import { TrackerStore } from "./tracker-store.ts";
import type { ModelChoice, SubagentRecord, TrackerRecord } from "./types.ts";

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

export interface SubagentSidebarRecord {
	id: string;
	label?: string;
	description: string;
	status: SubagentRecord["status"];
	subagentType: string;
	trackerId?: string;
	branch?: string;
	cwd: string;
	currentTool?: string;
	lastTool?: string;
	turnCount: number;
	updatedAt: string;
	previewLines: string[];
}

const DEFAULT_SUBAGENT_TYPE = "general-purpose";
const SIDEBAR_PREVIEW_CHAR_LIMIT = 4000;
const SIDEBAR_PREVIEW_LINE_LIMIT = 5;

function trimPreviewText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (normalized.length <= SIDEBAR_PREVIEW_CHAR_LIMIT) {
		return normalized;
	}
	return normalized.slice(-SIDEBAR_PREVIEW_CHAR_LIMIT).trimStart();
}

function previewLinesFromText(text: string): string[] {
	return trimPreviewText(text)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-SIDEBAR_PREVIEW_LINE_LIMIT);
}

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
	private readonly manager: AgentManager;
	private readonly trackerStore: TrackerStore;
	private readonly leaderExtensionNames: string[];
	private readonly sidebarState = new Map<
		string,
		{
			assistantText: string;
			currentTool?: string;
			lastTool?: string;
			turnCount: number;
			updatedAt: number;
		}
	>();
	private readonly sidebarListeners = new Set<() => void>();
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
	private sidebarFlushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(pi: ExtensionAPI, options: { leaderExtensionNames: string[]; trackerStore?: TrackerStore }) {
		this.pi = pi;
		this.leaderExtensionNames = options.leaderExtensionNames;
		this.trackerStore = options.trackerStore ?? new TrackerStore();
		this.manager = new AgentManager((record) => {
			void this.handleSubagentComplete(record);
		}, undefined, (record) => {
			this.handleSubagentStart(record);
		});
	}

	private ensureSidebarState(id: string): {
		assistantText: string;
		currentTool?: string;
		lastTool?: string;
		turnCount: number;
		updatedAt: number;
	} {
		let state = this.sidebarState.get(id);
		if (!state) {
			state = {
				assistantText: "",
				turnCount: 0,
				updatedAt: Date.now(),
			};
			this.sidebarState.set(id, state);
		}
		return state;
	}

	private scheduleSidebarFlush(): void {
		if (this.sidebarFlushTimer) {
			return;
		}
		this.sidebarFlushTimer = setTimeout(() => {
			this.sidebarFlushTimer = undefined;
			for (const listener of this.sidebarListeners) {
				try {
					listener();
				} catch {
					// Sidebar listeners should not affect agent state.
				}
			}
		}, 75);
		this.sidebarFlushTimer.unref?.();
	}

	private updateSidebarState(
		id: string,
		updater: (state: { assistantText: string; currentTool?: string; lastTool?: string; turnCount: number; updatedAt: number }) => void,
	): void {
		const state = this.ensureSidebarState(id);
		updater(state);
		state.updatedAt = Date.now();
		this.scheduleSidebarFlush();
	}

	private buildLiveCallbacks(getId: () => string): {
		onTextDelta: (delta: string, fullText: string) => void;
		onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => void;
		onTurnEnd: (turnCount: number) => void;
	} {
		return {
			onTextDelta: (_delta, fullText) => {
				const id = getId();
				if (!id) {
					return;
				}
				this.updateSidebarState(id, (state) => {
					state.assistantText = trimPreviewText(fullText);
				});
			},
			onToolActivity: (activity) => {
				const id = getId();
				if (!id) {
					return;
				}
				this.updateSidebarState(id, (state) => {
					if (activity.type === "start") {
						state.currentTool = activity.toolName;
						return;
					}
					state.lastTool = activity.toolName;
					if (state.currentTool === activity.toolName) {
						state.currentTool = undefined;
					}
				});
			},
			onTurnEnd: (turnCount) => {
				const id = getId();
				if (!id) {
					return;
				}
				this.updateSidebarState(id, (state) => {
					state.turnCount = turnCount;
				});
			},
		};
	}

	private syncSidebarStateFromRecord(record: InternalAgentRecord): void {
		this.updateSidebarState(record.id, (state) => {
			const preview = record.result?.trim() || record.error?.trim();
			if (preview) {
				state.assistantText = trimPreviewText(preview);
			}
			state.currentTool = undefined;
		});
	}

	private handleSubagentStart(record: InternalAgentRecord): void {
		this.updateSidebarState(record.id, (state) => {
			state.assistantText = "";
			state.currentTool = undefined;
			state.lastTool = undefined;
			state.turnCount = 0;
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

	subscribeSidebar(listener: () => void): () => void {
		this.sidebarListeners.add(listener);
		return () => {
			this.sidebarListeners.delete(listener);
		};
	}

	listSidebarRecords(): SubagentSidebarRecord[] {
		const statusRank: Record<SubagentRecord["status"], number> = {
			running: 0,
			queued: 1,
			steered: 2,
			completed: 3,
			error: 4,
			aborted: 5,
			stopped: 6,
		};

		return this.manager.listAgents()
			.map((record) => {
				const mapped = this.mapRecord(record);
				const sidebarState = this.ensureSidebarState(record.id);
				const previewSource = sidebarState.assistantText || mapped.result?.trim() || mapped.error?.trim() || "";
				return {
					id: mapped.id,
					label: mapped.label,
					description: mapped.description,
					status: mapped.status,
					subagentType: mapped.subagentType,
					trackerId: mapped.trackerId,
					branch: mapped.worktreeResult?.branch ?? mapped.worktree?.branch,
					cwd: mapped.cwd,
					currentTool: sidebarState.currentTool,
					lastTool: sidebarState.lastTool,
					turnCount: sidebarState.turnCount,
					updatedAt: new Date(sidebarState.updatedAt).toISOString(),
					previewLines: previewLinesFromText(previewSource),
				};
			})
			.sort((left, right) => {
				const statusDelta = statusRank[left.status] - statusRank[right.status];
				if (statusDelta !== 0) {
					return statusDelta;
				}
				return right.updatedAt.localeCompare(left.updatedAt);
			});
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

	private mapRecord(record: InternalAgentRecord): SubagentRecord {
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

	private cleanupManagedWorktree(record: InternalAgentRecord): BranchWorktreeCleanupResult | undefined {
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

	private async handleSubagentComplete(record: InternalAgentRecord): Promise<void> {
		this.cleanupManagedWorktree(record);
		this.syncSidebarStateFromRecord(record);
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

	private requireRecord(id: string): InternalAgentRecord {
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
		name?: string;
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

		let model: Exclude<ReturnType<typeof resolveModel>, string> | undefined;
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

		const displayName = options.name?.trim() || undefined;
		const description = displayName || summarizeTask(options.task);
		const tracker = options.trackerId
			? await this.trackerStore.get(options.cwd, options.trackerId)
			: await this.trackerStore.create(options.cwd, { title: description, description: options.task });
		const worktree = createBranchWorktree(options.cwd, displayName);
		if (!worktree) {
			throw new Error('Cannot run with isolation: "worktree" - failed to create a branch-backed git worktree. Initialize git and commit at least once, or fix git worktree creation.');
		}

		let id: string;
		let liveId = "";
		const liveCallbacks = this.buildLiveCallbacks(() => liveId);
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
				...liveCallbacks,
			});
			liveId = id;
		} catch (error) {
			cleanupBranchWorktree(options.cwd, worktree, description);
			throw error;
		}

		this.metadata.set(id, {
			cwd: options.cwd,
			description,
			label: displayName,
			model: options.model,
			trackerId: tracker.id,
			worktree,
		});
		this.updateSidebarState(id, (state) => {
			state.assistantText = "";
			state.currentTool = undefined;
			state.lastTool = undefined;
			state.turnCount = 0;
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
		const resumed = await this.manager.resume(id, message, this.buildLiveCallbacks(() => id));
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
		this.syncSidebarStateFromRecord(record);
		return this.mapRecord(record);
	}

	async shutdown(): Promise<void> {
		this.manager.abortAll();
		for (const record of this.manager.listAgents()) {
			this.cleanupManagedWorktree(record);
		}
		this.manager.dispose();
		if (this.sidebarFlushTimer) {
			clearTimeout(this.sidebarFlushTimer);
			this.sidebarFlushTimer = undefined;
		}
		this.sidebarListeners.clear();
		this.sidebarState.clear();
		this.metadata.clear();
		this.pendingUpdates.clear();
	}
}
