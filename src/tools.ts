import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentManager } from "./subagent-manager.ts";

const ThinkingLevelSchema = Type.Union(
	[
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
	],
	{ description: "Subagent thinking level" },
);

const ModelChoiceSchema = Type.Object({
	provider: Type.String({ description: "Model provider name" }),
	modelId: Type.String({ description: "Model id" }),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

export function createSpawnSubagentTool(manager: SubagentManager) {
	return defineTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Spawn a persistent subagent to work on a delegated task in an isolated worktree.",
		promptGuidelines: [
			"Use spawn_subagent when you need a separate agent to explore, code, or test in parallel.",
			"Use spawn_subagent instead of doing the delegated work directly in leader mode.",
			"Subagents run in background and wake the leader with a completion update.",
			"Worktree branches are created only when the subagent changes files; read the saved branch from the completion update.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task for the subagent" }),
			subagent_type: Type.Optional(
				Type.String({
					description: "Subagent type. Built-ins are general-purpose, Explore, and Plan; custom .pi/agents/*.md types also work.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
			label: Type.Optional(Type.String({ description: "Optional readable subagent label" })),
			model: Type.Optional(ModelChoiceSchema),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = await manager.spawn({
				ctx,
				task: params.task,
				cwd: params.cwd ?? ctx.cwd,
				label: params.label,
				model: params.model,
				subagentType: params.subagent_type,
			});
			const location = record.worktree?.path ? ` Worktree: ${record.worktree.path}.` : "";
			return {
				content: [{ type: "text", text: `Spawned subagent ${record.id} (${record.subagentType}).${location}` }],
				details: { record },
			};
		},
	});
}

export function createSendToSubagentTool(manager: SubagentManager) {
	return defineTool({
		name: "send_to_subagent",
		label: "Send To Subagent",
		description: "Steer a running subagent or resume a completed one with a new prompt.",
		promptGuidelines: [
			"Use send_to_subagent when you need to refine, redirect, or continue work on an existing subagent.",
			"Running or queued subagents receive the message as a steer. Completed subagents resume their preserved session with the new prompt.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Subagent id" }),
			message: Type.String({ description: "Message to send" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")], {
					description: "Delivery mode for the subagent message",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const record = await manager.send(params.id, params.message, params.mode);
			return {
				content: [{ type: "text", text: `Sent message to ${record.id}.` }],
				details: { record },
			};
		},
	});
}

export function createListAvailableModelsTool() {
	return defineTool({
		name: "list_available_models",
		label: "List Available Models",
		description: "List models currently available to the leader session for subagent selection.",
		promptGuidelines: [
			"Use list_available_models before spawning subagents when model selection matters and you need the actual available provider/model ids.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const models = await ctx.modelRegistry.getAvailable();
			const text = models.map((model) => `${model.provider}/${model.id}`).join("\n") || "No available models.";
			return {
				content: [{ type: "text", text }],
				details: { models },
			};
		},
	});
}

export function parseThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
	if (!level) {
		return undefined;
	}
	return level as ThinkingLevel;
}
