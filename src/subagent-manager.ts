import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentRecord as PiSubagentRecord } from "@tintinweb/pi-subagents/dist/types.js";
import { LEADER_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "./prompt.ts";
import type { ModelChoice, SubagentRecord } from "./types.ts";

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
	lastAssistantText?: string;
	branch?: string;
	error?: string;
}

const DEFAULT_SUBAGENT_TYPE = "general-purpose";
const DEFAULT_ISOLATION = "worktree";
const MAX_UPDATE_TEXT_CHARS = 600;

function stripLeaderPrompt(systemPrompt: string): string {
	const suffix = `\n\n${LEADER_SYSTEM_PROMPT}`;
	if (systemPrompt.endsWith(suffix)) {
		return systemPrompt.slice(0, -suffix.length).trimEnd();
	}
	return systemPrompt.replace(LEADER_SYSTEM_PROMPT, "").trim();
}

function truncateText(text: string | undefined, maxChars = MAX_UPDATE_TEXT_CHARS): string | undefined {
	const normalized = text?.trim();
	if (!normalized) {
		return undefined;
	}
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
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
		const summary = update.lastAssistantText?.trim() || update.error?.trim() || "(no assistant output)";
		const branch = update.branch ? ` saved_branch=${update.branch}` : "";
		return `- ${title} [${update.status}]${branch}: ${summary}`;
	});
	return `Subagent update:\n${lines.join("\n")}`;
}

export class SubagentManager {
	protected readonly pi: ExtensionAPI;
	private readonly manager: PiSubagentsAgentManager;
	private readonly leaderExtensionNames: string[];
	private readonly metadata = new Map<
		string,
		{
			cwd: string;
			description: string;
			label?: string;
			model?: ModelChoice;
		}
	>();
	private readonly pendingUpdates = new Map<string, SubagentUpdateDetail>();
	private flushScheduled = false;

	constructor(pi: ExtensionAPI, options: { leaderExtensionNames: string[] }) {
		this.pi = pi;
		this.leaderExtensionNames = options.leaderExtensionNames;
		this.manager = new PiSubagentsAgentManager((record) => {
			this.handleSubagentComplete(record);
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
		const branch = record.worktreeResult?.branch ?? record.worktree?.branch;
		return {
			id: record.id,
			createdAt: new Date(record.startedAt).toISOString(),
			cwd: metadata?.cwd ?? record.worktree?.workPath ?? record.worktree?.path ?? "",
			description: metadata?.description ?? record.description,
			label: metadata?.label,
			lastAssistantText: truncateText(record.result ?? record.error),
			model: metadata?.model,
			result: record.result,
			error: record.error,
			status: record.status,
			subagentType: record.type,
			worktree: record.worktree
				? {
					branch,
					path: record.worktree.path,
					baseSha: record.worktree.baseSha,
					workPath: record.worktree.workPath,
				}
				: undefined,
			worktreeResult: record.worktreeResult
				? {
					hasChanges: record.worktreeResult.hasChanges,
					branch: record.worktreeResult.branch,
				}
				: undefined,
		};
	}

	private buildUpdate(record: SubagentRecord): SubagentUpdateDetail {
		return {
			id: record.id,
			label: record.label,
			status: record.status,
			lastAssistantText: record.lastAssistantText,
			branch: record.worktreeResult?.branch,
			error: record.error,
		};
	}

	private handleSubagentComplete(record: PiSubagentRecord): void {
		this.enqueueUpdate(this.buildUpdate(this.mapRecord(record)));
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
		const id = this.manager.spawn(this.pi, options.ctx, subagentType, options.task, {
			description,
			cwd: options.cwd,
			model,
			maxTurns: agentConfig?.maxTurns,
			isolated: agentConfig?.isolated ?? false,
			inheritContext: agentConfig?.inheritContext ?? false,
			thinkingLevel: agentConfig?.thinking ?? options.model?.thinkingLevel,
			isBackground: true,
			isolation: agentConfig?.isolation ?? DEFAULT_ISOLATION,
		});

		this.metadata.set(id, {
			cwd: options.cwd,
			description,
			label: options.label?.trim() || undefined,
			model: options.model,
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

	async stop(id: string): Promise<SubagentRecord> {
		if (!this.manager.abort(id)) {
			throw new Error(`Unknown subagent: ${id}`);
		}
		return this.mapRecord(this.requireRecord(id));
	}

	async shutdown(): Promise<void> {
		this.manager.abortAll();
		this.manager.dispose();
		this.metadata.clear();
		this.pendingUpdates.clear();
	}
}
