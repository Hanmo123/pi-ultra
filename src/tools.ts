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
			"All subagents work in isolated worktrees with separate git branches.",
			"Specify a descriptive branch name for the subagent's work.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task for the subagent" }),
			branch: Type.String({ description: "Branch name for the subagent's worktree (required)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
			label: Type.Optional(Type.String({ description: "Optional readable subagent label" })),
			model: Type.Optional(ModelChoiceSchema),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = await manager.spawn({
				task: params.task,
				branch: params.branch,
				cwd: params.cwd ?? ctx.cwd,
				label: params.label,
				model: params.model,
			});
			return {
				content: [{ type: "text", text: `Spawned subagent ${record.id} in worktree branch ${record.worktree?.branch}.` }],
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
			"Use strategy 'merge' (default) for a merge commit with --no-ff, or 'squash' to squash all commits into one.",
			"If conflicts are reported, send a message to the subagent with conflict details so it can resolve them in its worktree.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Subagent id" }),
			into: Type.Optional(Type.String({ description: "Target branch to merge into" })),
			strategy: Type.Optional(
				Type.Union([Type.Literal("merge"), Type.Literal("squash")], {
					description: "Merge strategy: 'merge' (default, --no-ff) or 'squash' (--squash)",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const result = await manager.merge(params.id, params.into, params.strategy);
			const strategyLabel = params.strategy === "squash" ? " (squashed)" : "";
			const text = result.merged
				? `Merged ${result.record.worktree?.branch} into ${params.into ?? "current branch"}${strategyLabel}.`
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
