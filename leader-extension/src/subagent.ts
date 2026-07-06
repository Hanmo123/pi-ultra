import type { AgentSessionEvent, RpcResponse } from "@earendil-works/pi-coding-agent";
import { createRpcProcessInstance, type RpcProcessInstance } from "./rpc-process.ts";
import type { ModelChoice, SubagentRecord } from "./types.ts";

function isSuccessResponse<TCommand extends RpcResponse["command"]>(
	response: RpcResponse,
	command: TCommand,
): response is Extract<RpcResponse, { success: true; command: TCommand }> {
	return response.success === true && response.command === command;
}

export class Subagent {
	readonly id: string;
	readonly label?: string;
	readonly cwd: string;

	private readonly rpcProcess: RpcProcessInstance;
	private record: SubagentRecord;
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private unsubscribeEvents?: () => void;
	private unsubscribeExit?: () => void;
	private disposed = false;

	constructor(options: { id: string; cwd: string; label?: string; worktree?: SubagentRecord["worktree"] }) {
		this.id = options.id;
		this.label = options.label;
		this.cwd = options.cwd;
		this.rpcProcess = createRpcProcessInstance({ cwd: options.cwd });
		const createdAt = new Date().toISOString();
		this.record = {
			id: options.id,
			createdAt,
			cwd: options.cwd,
			label: options.label,
			pendingReactivation: false,
			status: "starting",
			worktree: options.worktree,
		};
		this.unsubscribeEvents = this.rpcProcess.onEvent((event) => {
			this.updateStatusFromEvent(event);
			for (const listener of this.eventListeners) {
				listener(event);
			}
		});
		this.unsubscribeExit = this.rpcProcess.onExit((error) => {
			this.record = {
				...this.record,
				status: this.disposed ? "stopped" : "error",
			};
			for (const listener of this.exitListeners) {
				listener(error);
			}
		});
	}

	private updateStatusFromEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start" || event.type === "turn_start") {
			this.record = { ...this.record, status: "working" };
			return;
		}
		if (event.type === "agent_end" || event.type === "turn_end") {
			this.record = { ...this.record, status: "idle" };
		}
	}

	private requireSuccess<TCommand extends RpcResponse["command"]>(
		response: RpcResponse,
		command: TCommand,
	): Extract<RpcResponse, { success: true; command: TCommand }> {
		if (!isSuccessResponse(response, command)) {
			if (response.success === false) {
				throw new Error(response.error);
			}
			throw new Error(`Unexpected RPC response for ${command}`);
		}
		return response;
	}

	private async refreshLastAssistantText(): Promise<void> {
		const response = this.requireSuccess(
			await this.rpcProcess.send({ type: "get_last_assistant_text" }),
			"get_last_assistant_text",
		);
		this.record = {
			...this.record,
			lastAssistantText: response.data.text ?? undefined,
		};
	}

	getRecord(): SubagentRecord {
		return { ...this.record };
	}

	setPendingReactivation(pendingReactivation: boolean): void {
		this.record = { ...this.record, pendingReactivation };
	}

	async initialize(model?: ModelChoice): Promise<void> {
		if (!model) {
			this.record = { ...this.record, status: "idle" };
			return;
		}
		const response = await this.rpcProcess.send({
			type: "set_model",
			provider: model.provider,
			modelId: model.modelId,
		});
		this.requireSuccess(response, "set_model");
		if (model.thinkingLevel) {
			const thinkingResponse = await this.rpcProcess.send({
				type: "set_thinking_level",
				level: model.thinkingLevel,
			});
			this.requireSuccess(thinkingResponse, "set_thinking_level");
		}
		this.record = {
			...this.record,
			model,
			status: "idle",
		};
	}

	async prompt(message: string): Promise<void> {
		this.record = { ...this.record, status: "working" };
		this.requireSuccess(await this.rpcProcess.send({ type: "prompt", message }), "prompt");
	}

	async steer(message: string): Promise<void> {
		this.requireSuccess(await this.rpcProcess.send({ type: "steer", message }), "steer");
	}

	async followUp(message: string): Promise<void> {
		this.requireSuccess(await this.rpcProcess.send({ type: "follow_up", message }), "follow_up");
	}

	async abort(): Promise<void> {
		this.requireSuccess(await this.rpcProcess.send({ type: "abort" }), "abort");
	}

	async syncState(): Promise<SubagentRecord> {
		const response = this.requireSuccess(await this.rpcProcess.send({ type: "get_state" }), "get_state");
		await this.refreshLastAssistantText();
		this.record = {
			...this.record,
			status: response.data.isStreaming
				? "working"
				: this.record.status === "starting"
					? "idle"
					: this.record.status,
		};
		return this.getRecord();
	}

	async getLastAssistantText(): Promise<string | undefined> {
		await this.refreshLastAssistantText();
		return this.record.lastAssistantText;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		this.unsubscribeExit?.();
		this.unsubscribeExit = undefined;
		await this.rpcProcess.dispose();
		this.record = { ...this.record, status: "stopped", pendingReactivation: false };
	}
}

export function createSubagent(options: {
	id: string;
	cwd: string;
	label?: string;
	worktree?: SubagentRecord["worktree"];
}): Subagent {
	return new Subagent(options);
}
