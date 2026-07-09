import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatPiUltraModelChoices,
	loadPiUltraModelChoices,
	PI_ULTRA_CHOICES_KEY,
	PI_ULTRA_MODELS_PATH,
} from "./model-config.ts";
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
			tracker_id: Type.Optional(Type.String({ description: "Tracker id to attach this subagent result to. If omitted, a tracker is created automatically." })),
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
				trackerId: params.tracker_id,
			});
			const location = record.worktree?.path ? ` Worktree: ${record.worktree.path}.` : "";
			const tracker = record.trackerId ? ` Tracker: ${record.trackerId}.` : "";
			return {
				content: [{ type: "text", text: `Spawned subagent ${record.id} (${record.subagentType}).${tracker}${location}` }],
				details: { record },
			};
		},
	});
}

export function createCreateTrackerTool(manager: SubagentManager) {
	return defineTool({
		name: "create_tracker",
		label: "Create Tracker",
		description: "Create a file-backed tracker for a user issue or goal.",
		promptGuidelines: [
			"Use create_tracker for multi-step user goals before spawning several related subagents.",
			"Pass the returned tracker id to spawn_subagent so related branch comments stay grouped.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short tracker title" }),
			description: Type.Optional(Type.String({ description: "Tracker description or original user goal" })),
			cwd: Type.Optional(Type.String({ description: "Repository or project directory for the tracker" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = await manager.createTracker(params.cwd ?? ctx.cwd, params.title, params.description);
			return {
				content: [{ type: "text", text: `Created tracker ${record.id}. Path: ${record.path}` }],
				details: { record },
			};
		},
	});
}

export function createListTrackersTool(manager: SubagentManager) {
	return defineTool({
		name: "list_trackers",
		label: "List Trackers",
		description: "List file-backed trackers for the current project.",
		promptGuidelines: [
			"Use list_trackers to find existing issue trackers before creating a new one.",
		],
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Repository or project directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const records = await manager.listTrackers(params.cwd ?? ctx.cwd);
			const text = records.map((record) => `${record.id} - ${record.title} (${Object.keys(record.branches).length} branch(es))\n${record.path}`).join("\n") || "No trackers.";
			return {
				content: [{ type: "text", text }],
				details: { records },
			};
		},
	});
}

export function createReadTrackerTool(manager: SubagentManager) {
	return defineTool({
		name: "read_tracker",
		label: "Read Tracker",
		description: "Read a tracker with all branch comments.",
		promptGuidelines: [
			"Use read_tracker after tracker update notifications instead of relying on subagent completion summaries.",
			"Use read_tracker before reporting subagent results, comparing branches, or deciding merge readiness.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Tracker id" }),
			cwd: Type.Optional(Type.String({ description: "Repository or project directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await manager.readTracker(params.cwd ?? ctx.cwd, params.id);
			return {
				content: [{ type: "text", text: result.markdown }],
				details: result,
			};
		},
	});
}

export function createCommentTrackerTool(manager: SubagentManager) {
	return defineTool({
		name: "comment_tracker",
		label: "Comment Tracker",
		description: "Append a leader comment to a tracker branch.",
		promptGuidelines: [
			"Use comment_tracker to record leader decisions, merge conclusions, user clarifications, or review notes.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Tracker id" }),
			branch: Type.String({ description: "Branch name or logical branch bucket" }),
			body: Type.String({ description: "Markdown comment body" }),
			cwd: Type.Optional(Type.String({ description: "Repository or project directory" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await manager.commentTracker(params.cwd ?? ctx.cwd, params.id, params.branch, params.body);
			return {
				content: [{ type: "text", text: `Commented on tracker ${result.record.id}. File: ${result.branchPath}` }],
				details: result,
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
			"Treat configured pi-ultra-choices as soft guidance; map natural-language model names to the closest available provider/model id.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const [models, modelChoices] = await Promise.all([
				ctx.modelRegistry.getAvailable(),
				loadPiUltraModelChoices(),
			]);
			const modelText = models.map((model) => `${model.provider}/${model.id}`).join("\n") || "No available models.";
			const choiceText = modelChoices.length > 0
				? `${PI_ULTRA_CHOICES_KEY}:\n${formatPiUltraModelChoices(modelChoices)}`
				: `No configured ${PI_ULTRA_CHOICES_KEY}.`;
			const text = `${modelText}\n\n${choiceText}`;
			return {
				content: [{ type: "text", text }],
				details: { models, [PI_ULTRA_CHOICES_KEY]: modelChoices, configPath: PI_ULTRA_MODELS_PATH },
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
