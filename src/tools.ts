import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentManager } from "./subagent-manager.ts";

const WorktreeSchema = Type.Object({
	branch: Type.Optional(Type.String({ description: "Branch name to create for the subagent worktree" })),
	path: Type.Optional(Type.String({ description: "Optional explicit worktree path" })),
});

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
		description: "Spawn a persistent subagent to work on a delegated task.",
		promptGuidelines: [
			"Use spawn_subagent when you need a separate agent to explore, code, or test in parallel.",
			"Use spawn_subagent instead of doing the delegated work directly in leader mode.",
			"Use spawn_subagent with worktree when multiple coding subagents need isolated git state in parallel.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
			label: Type.Optional(Type.String({ description: "Optional readable subagent label" })),
			model: Type.Optional(ModelChoiceSchema),
			worktree: Type.Optional(WorktreeSchema),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = await manager.spawn({
				task: params.task,
				cwd: params.cwd ?? ctx.cwd,
				label: params.label,
				model: params.model,
				worktree: params.worktree,
			});
			return {
				content: [{ type: "text", text: `Spawned subagent ${record.id}.` }],
				details: { record },
			};
		},
	});
}

export function createSendToSubagentTool(manager: SubagentManager) {
	return defineTool({
		name: "send_to_subagent",
		label: "Send To Subagent",
		description: "Send a message to a running subagent.",
		promptGuidelines: [
			"Use send_to_subagent when you need to refine, redirect, or continue work on an existing subagent.",
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

export function createMergeSubagentWorktreeTool(manager: SubagentManager) {
	return defineTool({
		name: "merge_subagent_worktree",
		label: "Merge Subagent Worktree",
		description: "Merge a worktree-backed subagent branch into a target branch.",
		promptGuidelines: [
			"Use merge_subagent_worktree when a worktree-backed subagent has completed coding and its branch should be merged.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Subagent id" }),
			into: Type.Optional(Type.String({ description: "Target branch to merge into" })),
		}),
		async execute(_toolCallId, params) {
			const result = await manager.merge(params.id, params.into);
			const text = result.merged
				? `Merged ${result.record.worktree?.branch} into ${params.into ?? "current branch"}.`
				: `Merge of ${result.record.worktree?.branch} reported conflicts: ${result.conflictedFiles.join(", ") || "(none listed)"}`;
			return {
				content: [{ type: "text", text }],
				details: result,
				isError: !result.merged,
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
