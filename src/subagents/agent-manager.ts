import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage } from "./usage.ts";
import { resumeAgent, runAgent, type RunOptions, type ToolActivity } from "./agent-runner.ts";
import type { AgentRecord, SubagentType, ThinkingLevel } from "./types.ts";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;

const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnOptions {
	description: string;
	model?: RunOptions["model"];
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	isBackground?: boolean;
	bypassQueue?: boolean;
	cwd?: string;
	signal?: AbortSignal;
	onToolActivity?: (activity: ToolActivity) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onSessionCreated?: RunOptions["onSessionCreated"];
	onTurnEnd?: (turnCount: number) => void;
	onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

interface SpawnArgs {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	type: SubagentType;
	prompt: string;
	options: SpawnOptions;
}

function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
	if (cwd == null) {
		return;
	}
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
	}
	let isDirectory = false;
	try {
		isDirectory = statSync(cwd).isDirectory();
	} catch {
		throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
	}
	if (!isDirectory) {
		throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
	}
}

export class AgentManager {
	private readonly agents = new Map<string, AgentRecord>();
	private readonly cleanupInterval: ReturnType<typeof setInterval>;
	private readonly onComplete?: OnAgentComplete;
	private readonly onStart?: OnAgentStart;
	private readonly onCompact?: OnAgentCompact;
	private maxConcurrent: number;
	private queue: { id: string; args: SpawnArgs }[] = [];
	private runningBackground = 0;

	constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart, onCompact?: OnAgentCompact) {
		this.onComplete = onComplete;
		this.onStart = onStart;
		this.onCompact = onCompact;
		this.maxConcurrent = maxConcurrent;
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
		this.cleanupInterval.unref?.();
	}

	spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
		assertValidSpawnCwd(options.cwd);
		const id = randomUUID().slice(0, 17);
		const record: AgentRecord = {
			id,
			type,
			description: options.description,
			status: options.isBackground ? "queued" : "running",
			toolUses: 0,
			startedAt: Date.now(),
			abortController: new AbortController(),
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
			isBackground: options.isBackground,
		};
		this.agents.set(id, record);

		const args = { pi, ctx, type, prompt, options };
		if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
			this.queue.push({ id, args });
			return id;
		}

		try {
			this.startAgent(id, record, args);
		} catch (error) {
			this.agents.delete(id);
			throw error;
		}
		return id;
	}

	private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs): void {
		assertValidSpawnCwd(options.cwd);
		const customCwd = options.cwd ?? undefined;
		record.status = "running";
		record.startedAt = Date.now();
		if (options.isBackground) {
			this.runningBackground++;
		}
		this.onStart?.(record);

		let detachParentSignal: (() => void) | undefined;
		if (options.signal) {
			const onParentAbort = () => this.abort(id);
			options.signal.addEventListener("abort", onParentAbort, { once: true });
			detachParentSignal = () => options.signal?.removeEventListener("abort", onParentAbort);
		}
		const detach = () => {
			detachParentSignal?.();
			detachParentSignal = undefined;
		};

		const promise = runAgent(ctx, type, prompt, {
			pi,
			agentId: id,
			model: options.model,
			maxTurns: options.maxTurns,
			isolated: options.isolated,
			inheritContext: options.inheritContext,
			thinkingLevel: options.thinkingLevel,
			cwd: customCwd,
			configCwd: customCwd !== undefined ? ctx.cwd : undefined,
			signal: record.abortController?.signal,
			onToolActivity: (activity) => {
				if (activity.type === "end") {
					record.toolUses++;
				}
				options.onToolActivity?.(activity);
			},
			onTurnEnd: options.onTurnEnd,
			onTextDelta: options.onTextDelta,
			onAssistantUsage: (usage) => {
				addUsage(record.lifetimeUsage, usage);
				options.onAssistantUsage?.(usage);
			},
			onCompaction: (info) => {
				record.compactionCount++;
				this.onCompact?.(record, info);
				options.onCompaction?.(info);
			},
			onSessionCreated: (session) => {
				record.session = session;
				if (record.pendingSteers?.length) {
					for (const message of record.pendingSteers) {
						session.steer(message).catch(() => {});
					}
					record.pendingSteers = undefined;
				}
				options.onSessionCreated?.(session);
			},
		})
			.then(({ responseText, session, aborted, steered }) => {
				if (record.status !== "stopped") {
					record.status = aborted ? "aborted" : steered ? "steered" : "completed";
				}
				record.result = responseText;
				record.session = session;
				record.completedAt ??= Date.now();
				detach();
				this.finishRun(record, options.isBackground);
				return responseText;
			})
			.catch((error) => {
				if (record.status !== "stopped") {
					record.status = "error";
				}
				record.error = error instanceof Error ? error.message : String(error);
				record.completedAt ??= Date.now();
				detach();
				this.finishRun(record, options.isBackground);
				return "";
			});

		record.promise = promise;
	}

	private finishRun(record: AgentRecord, isBackground: boolean | undefined): void {
		if (!isBackground) {
			record.resultConsumed = true;
			try {
				this.onComplete?.(record);
			} catch {
				// Completion callbacks should not change agent lifecycle state.
			}
			return;
		}
		this.runningBackground = Math.max(0, this.runningBackground - 1);
		try {
			this.onComplete?.(record);
		} catch {
			// Completion callbacks should not change agent lifecycle state.
		}
		this.drainQueue();
	}

	private drainQueue(): void {
		while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
			const next = this.queue.shift();
			if (!next) {
				continue;
			}
			const record = this.agents.get(next.id);
			if (!record || record.status !== "queued") {
				continue;
			}
			try {
				this.startAgent(next.id, record, next.args);
			} catch (error) {
				record.status = "error";
				record.error = error instanceof Error ? error.message : String(error);
				record.completedAt = Date.now();
				this.onComplete?.(record);
			}
		}
	}

	async resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined> {
		const record = this.agents.get(id);
		if (!record?.session) {
			return undefined;
		}
		record.status = "running";
		record.startedAt = Date.now();
		record.completedAt = undefined;
		record.result = undefined;
		record.error = undefined;

		try {
			const responseText = await resumeAgent(record.session, prompt, {
				onToolActivity: (activity) => {
					if (activity.type === "end") {
						record.toolUses++;
					}
				},
				onAssistantUsage: (usage) => addUsage(record.lifetimeUsage, usage),
				onCompaction: (info) => {
					record.compactionCount++;
					this.onCompact?.(record, info);
				},
				signal,
			});
			record.status = "completed";
			record.result = responseText;
			record.completedAt = Date.now();
		} catch (error) {
			record.status = "error";
			record.error = error instanceof Error ? error.message : String(error);
			record.completedAt = Date.now();
		}

		return record;
	}

	steer(id: string, message: string): boolean {
		const record = this.agents.get(id);
		if (!record || (record.status !== "running" && record.status !== "queued")) {
			return false;
		}
		if (record.session) {
			record.session.steer(message).catch(() => {});
		} else {
			record.pendingSteers ??= [];
			record.pendingSteers.push(message);
		}
		return true;
	}

	getRecord(id: string): AgentRecord | undefined {
		return this.agents.get(id);
	}

	listAgents(): AgentRecord[] {
		return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	abort(id: string): boolean {
		const record = this.agents.get(id);
		if (!record) {
			return false;
		}
		if (record.status === "queued") {
			this.queue = this.queue.filter((queued) => queued.id !== id);
			record.status = "stopped";
			record.completedAt = Date.now();
			return true;
		}
		if (record.status !== "running") {
			return false;
		}
		record.abortController?.abort();
		record.status = "stopped";
		record.completedAt = Date.now();
		return true;
	}

	abortAll(): number {
		let count = 0;
		for (const queued of this.queue) {
			const record = this.agents.get(queued.id);
			if (record) {
				record.status = "stopped";
				record.completedAt = Date.now();
				count++;
			}
		}
		this.queue = [];
		for (const record of this.agents.values()) {
			if (record.status === "running") {
				record.abortController?.abort();
				record.status = "stopped";
				record.completedAt = Date.now();
				count++;
			}
		}
		return count;
	}

	dispose(): void {
		clearInterval(this.cleanupInterval);
		this.queue = [];
		for (const record of this.agents.values()) {
			record.session?.dispose();
		}
		this.agents.clear();
	}

	private cleanup(): void {
		const cutoff = Date.now() - 10 * 60_000;
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") {
				continue;
			}
			if ((record.completedAt ?? 0) >= cutoff) {
				continue;
			}
			record.session?.dispose?.();
			record.session = undefined;
			this.agents.delete(id);
		}
	}
}
