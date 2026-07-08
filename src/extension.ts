import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LEADER_SYSTEM_PROMPT } from "./prompt.ts";
import { SubagentManager } from "./subagent-manager.ts";
import {
	createCommentTrackerTool,
	createCreateTrackerTool,
	createListAvailableModelsTool,
	createListTrackersTool,
	createReadTrackerTool,
	createSendToSubagentTool,
	createSpawnSubagentTool,
} from "./tools.ts";

export interface LeaderExtensionOptions {
	createManager?: (pi: ExtensionAPI, leaderExtensionName: string) => SubagentManager;
}

const LEADER_STATE_TYPE = "leader-state";
const LEADER_EXTENSION_PATH = fileURLToPath(import.meta.url);
const LEADER_EXTENSION_NAMES = [
	basename(LEADER_EXTENSION_PATH).replace(/\.(ts|js)$/u, ""),
	basename(dirname(LEADER_EXTENSION_PATH)),
];

function getLeaderTools(): string[] {
	return [
		"bash",
		"create_tracker",
		"list_trackers",
		"read_tracker",
		"comment_tracker",
		"spawn_subagent",
		"send_to_subagent",
		"list_available_models",
	];
}

export function createLeaderExtension(options: LeaderExtensionOptions = {}) {
	return function leaderExtension(pi: ExtensionAPI): void {
		const manager = options.createManager
			? options.createManager(pi, LEADER_EXTENSION_NAMES[0])
			: new SubagentManager(pi, { leaderExtensionNames: LEADER_EXTENSION_NAMES });
		let leaderEnabled = true;
		let toolsBeforeLeader: string[] | undefined;

		function persistState(): void {
			pi.appendEntry(LEADER_STATE_TYPE, {
				enabled: leaderEnabled,
				toolsBeforeLeader,
			});
		}

		function updateStatus(ctx: ExtensionContext): void {
			ctx.ui.setStatus("leader-mode", leaderEnabled ? "leader" : undefined);
		}

		function enableLeaderMode(ctx: ExtensionContext): void {
			if (!leaderEnabled) {
				leaderEnabled = true;
			}
			if (toolsBeforeLeader === undefined) {
				toolsBeforeLeader = pi.getActiveTools();
			}
			pi.setActiveTools(getLeaderTools());
			updateStatus(ctx);
			persistState();
		}

		function disableLeaderMode(ctx: ExtensionContext): void {
			leaderEnabled = false;
			pi.setActiveTools(toolsBeforeLeader ?? ["read", "bash", "edit", "write"]);
			toolsBeforeLeader = undefined;
			updateStatus(ctx);
			persistState();
		}

		pi.registerTool(createSpawnSubagentTool(manager));
		pi.registerTool(createSendToSubagentTool(manager));
		pi.registerTool(createCreateTrackerTool(manager));
		pi.registerTool(createListTrackersTool(manager));
		pi.registerTool(createReadTrackerTool(manager));
		pi.registerTool(createCommentTrackerTool(manager));
		pi.registerTool(createListAvailableModelsTool());

		pi.registerCommand("leader", {
			description: "Enable, disable, inspect, or start leader mode",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (!trimmed || trimmed === "on") {
					enableLeaderMode(ctx);
					ctx.ui.notify("Leader mode enabled.", "info");
					return;
				}
				if (trimmed === "off") {
					disableLeaderMode(ctx);
					ctx.ui.notify("Leader mode disabled.", "info");
					return;
				}
				if (trimmed === "status") {
					const mode = leaderEnabled ? "enabled" : "disabled";
					const subagents = manager.list();
					ctx.ui.notify(`Leader mode ${mode}. Subagents: ${subagents.length}.`, "info");
					return;
				}
				enableLeaderMode(ctx);
				await ctx.waitForIdle();
				pi.sendUserMessage(trimmed);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			const stateEntries = ctx.sessionManager
				.getEntries()
				.filter(
					(entry: { type: string; customType?: string }) =>
						entry.type === "custom" && entry.customType === LEADER_STATE_TYPE,
				);
			const latestState = stateEntries.at(-1) as
				| { data?: { enabled?: boolean; toolsBeforeLeader?: string[] } }
				| undefined;
			leaderEnabled = latestState?.data?.enabled ?? true;
			toolsBeforeLeader = latestState?.data?.toolsBeforeLeader;
			if (leaderEnabled) {
				enableLeaderMode(ctx);
			} else {
				updateStatus(ctx);
			}
		});

		pi.on("before_agent_start", async (event) => {
			if (!leaderEnabled) {
				return;
			}
			return {
				systemPrompt: `${event.systemPrompt}\n\n${LEADER_SYSTEM_PROMPT}`,
			};
		});

		pi.on("turn_start", async () => {
			if (leaderEnabled) {
				persistState();
			}
		});

		pi.on("session_shutdown", async () => {
			await manager.shutdown();
		});
	};
}

const leaderExtension = createLeaderExtension();

export default leaderExtension;
