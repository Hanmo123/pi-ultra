import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getConfig,
	getMemoryToolNames,
	getReadOnlyMemoryToolNames,
	getToolNamesForType,
} from "./agent-types.ts";
import { buildParentContext, extractText } from "./context.ts";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import { detectEnv } from "./env.ts";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.ts";
import { buildAgentPrompt, type PromptExtras } from "./prompts.ts";
import { preloadSkills } from "./skill-loader.ts";
import type { SubagentType, ThinkingLevel } from "./types.ts";

type Model = NonNullable<ExtensionContext["model"]>;

const EXCLUDED_TOOL_NAMES = [
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"spawn_subagent",
	"send_to_subagent",
	"create_tracker",
	"list_trackers",
	"read_tracker",
	"comment_tracker",
];

export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
}

export interface RunOptions {
	pi: ExtensionAPI;
	agentId?: string;
	model?: Model;
	maxTurns?: number;
	signal?: AbortSignal;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	cwd?: string;
	configCwd?: string;
	onToolActivity?: (activity: ToolActivity) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onSessionCreated?: (session: AgentSession) => void;
	onTurnEnd?: (turnCount: number) => void;
	onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export interface RunResult {
	responseText: string;
	session: AgentSession;
	aborted: boolean;
	steered: boolean;
}

let defaultMaxTurns: number | undefined;
let graceTurns = 5;

function normalizeMaxTurns(turns: number | undefined): number | undefined {
	if (turns == null || turns === 0) {
		return undefined;
	}
	return Math.max(1, turns);
}

function resolveDefaultModel(parentModel: Model | undefined, registry: ExtensionContext["modelRegistry"], configModel?: string): Model | undefined {
	if (configModel) {
		const slashIdx = configModel.indexOf("/");
		if (slashIdx !== -1) {
			const provider = configModel.slice(0, slashIdx);
			const modelId = configModel.slice(slashIdx + 1);
			const available = registry.getAvailable?.();
			const availableKeys = available ? new Set(available.map((model) => `${model.provider}/${model.id}`)) : undefined;
			const found = registry.find(provider, modelId);
			if (found && (!availableKeys || availableKeys.has(`${provider}/${modelId}`))) {
				return found;
			}
		}
	}
	return parentModel;
}

function collectResponseText(session: AgentSession): { getText: () => string; unsubscribe: () => void } {
	let text = "";
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			text = "";
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
		}
	});
	return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		const text = extractText(message.content).trim();
		if (text) {
			return text;
		}
	}
	return "";
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) {
		return () => {};
	}
	const onAbort = () => session.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

function extensionCanonicalName(extensionPath: string): string {
	const base = basename(extensionPath);
	const name = base === "index.ts" || base === "index.js"
		? basename(dirname(extensionPath))
		: base.replace(/\.(ts|js)$/u, "");
	return name.toLowerCase();
}

function parseExtensionsSpec(entries: string[], cwd: string): { names: Set<string>; paths: string[]; wildcard: boolean } {
	const names = new Set<string>();
	const paths: string[] = [];
	let wildcard = false;

	for (const entry of entries) {
		if (!entry) {
			continue;
		}
		if (entry === "*") {
			wildcard = true;
			continue;
		}
		const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
		if (!isPathEntry) {
			names.add(entry.toLowerCase());
			continue;
		}
		let path = entry;
		if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
			path = homedir() + path.slice(1);
		}
		const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
		paths.push(absolutePath);
		names.add(extensionCanonicalName(absolutePath));
	}

	return { names, paths, wildcard };
}

function parseExtSelectors(entries: string[]): { extNames: Set<string>; narrowing: Map<string, Set<string>> } {
	const extNames = new Set<string>();
	const narrowing = new Map<string, Set<string>>();

	for (const raw of entries) {
		if (!raw) {
			continue;
		}
		const body = raw.slice("ext:".length);
		const slash = body.indexOf("/");
		const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
		if (!name) {
			continue;
		}
		extNames.add(name);
		if (slash === -1) {
			continue;
		}
		const tool = body.slice(slash + 1).trim();
		if (!tool) {
			continue;
		}
		let set = narrowing.get(name);
		if (!set) {
			set = new Set();
			narrowing.set(name, set);
		}
		set.add(tool);
	}

	return { extNames, narrowing };
}

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
	if (!sessionDir) {
		return undefined;
	}
	if (sessionDir === "~" || sessionDir.startsWith("~/")) {
		return resolve(homedir(), sessionDir.slice(2));
	}
	if (isAbsolute(sessionDir)) {
		return sessionDir;
	}
	return resolve(cwd, sessionDir);
}

export async function runAgent(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult> {
	const config = getConfig(type);
	const agentConfig = getAgentConfig(type);
	const effectiveCwd = options.cwd ?? ctx.cwd;
	const configCwd = options.configCwd ?? effectiveCwd;
	const env = await detectEnv(options.pi, effectiveCwd);
	const parentSystemPrompt = ctx.getSystemPrompt();
	const extras: PromptExtras = {};

	const extensions = options.isolated ? false : config.extensions;
	const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
	const skills = options.isolated ? false : config.skills;

	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, configCwd);
		if (loaded.length > 0) {
			extras.skillBlocks = loaded;
		}
	}

	let toolNames = getToolNamesForType(type);
	if (agentConfig?.memory) {
		const existingNames = new Set(toolNames);
		const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
		const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
		if (effectivelyHas("write") || effectivelyHas("edit")) {
			const extraNames = getMemoryToolNames(existingNames);
			if (extraNames.length > 0) {
				toolNames = [...toolNames, ...extraNames];
			}
			extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
		} else {
			const extraNames = getReadOnlyMemoryToolNames(existingNames);
			if (extraNames.length > 0) {
				toolNames = [...toolNames, ...extraNames];
			}
			extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
		}
	}

	const systemPrompt = agentConfig
		? buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras)
		: buildAgentPrompt({ ...DEFAULT_AGENTS.get("general-purpose")!, name: type }, effectiveCwd, env, parentSystemPrompt, extras);

	const noSkills = skills === false || Array.isArray(skills);
	const agentDir = getAgentDir();
	const { extNames, narrowing } = parseExtSelectors(options.isolated ? [] : (agentConfig?.extSelectors ?? []));
	const noExtensions = extensions === false;
	const extensionsSpec = Array.isArray(extensions) ? parseExtensionsSpec(extensions, configCwd) : undefined;
	const keepNames = extensionsSpec?.names ?? new Set<string>();
	const excludeNames = new Set((excludeExtensions ?? []).map((name) => name.toLowerCase()));
	const hasExcludes = excludeNames.size > 0;
	const loadAll = extensions === true || extensionsSpec?.wildcard === true;
	const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
	let discoveredNames: Set<string> | undefined;
	const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined = noExtensions || (loadAll && !hasExcludes)
		? undefined
		: (base) => {
			discoveredNames = new Set(base.extensions.map((extension) => extensionCanonicalName(extension.path)));
			return {
				...base,
				extensions: base.extensions.filter((extension) => {
					const name = extensionCanonicalName(extension.path);
					if (excludeNames.has(name)) {
						return false;
					}
					return loadAll || keepNames.has(name);
				}),
			};
		};

	const loader = new DefaultResourceLoader({
		cwd: configCwd,
		agentDir,
		noExtensions,
		additionalExtensionPaths,
		extensionsOverride,
		noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	if (agentConfig?.builtinToolNames?.length) {
		const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
		for (const name of agentConfig.builtinToolNames) {
			if (!knownBuiltins.has(name)) {
				options.onToolActivity?.({ type: "end", toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in` });
			}
		}
	}

	if (hasExcludes && noExtensions) {
		options.onToolActivity?.({ type: "end", toolName: `extension-error:exclude_extensions has no effect for agent "${type}" because extensions: false loads nothing` });
	}
	if (hasExcludes && discoveredNames) {
		for (const name of excludeNames) {
			if (!discoveredNames.has(name)) {
				options.onToolActivity?.({ type: "end", toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension` });
			}
		}
	}
	if (keepNames.size > 0 || extNames.size > 0) {
		const survivingNames = new Set(loader.getExtensions().extensions.map((extension) => extensionCanonicalName(extension.path)));
		for (const name of keepNames) {
			if (!survivingNames.has(name)) {
				options.onToolActivity?.({
					type: "end",
					toolName: excludeNames.has(name)
						? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" because exclude wins`
						: `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
				});
			}
		}
		for (const name of extNames) {
			if (!survivingNames.has(name)) {
				options.onToolActivity?.({ type: "end", toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded` });
			}
		}
	}

	const model = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
	const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;
	const disallowedSet = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
	const extensionToolNames: string[] = [];
	if (!noExtensions) {
		const optInActive = extNames.size > 0;
		for (const extension of loader.getExtensions().extensions) {
			const canon = extensionCanonicalName(extension.path);
			if (optInActive && !extNames.has(canon)) {
				continue;
			}
			const narrowed = narrowing.get(canon);
			for (const toolName of extension.tools.keys()) {
				if (narrowed && !narrowed.has(toolName)) {
					continue;
				}
				extensionToolNames.push(toolName);
			}
		}
	}

	const builtinToolNameSet = new Set(toolNames);
	const allowedTools = [...toolNames, ...extensionToolNames].filter((toolName) => {
		if (EXCLUDED_TOOL_NAMES.includes(toolName)) {
			return false;
		}
		if (disallowedSet?.has(toolName)) {
			return false;
		}
		if (builtinToolNameSet.has(toolName)) {
			return true;
		}
		return !noExtensions;
	});

	const settingsManager = SettingsManager.create(configCwd, agentDir);
	const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
	const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
	const sessionManager = agentConfig?.persistSession
		? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir)
		: SessionManager.inMemory(effectiveCwd);

	const sessionOptions: Parameters<typeof createAgentSession>[0] = {
		cwd: effectiveCwd,
		agentDir,
		sessionManager,
		settingsManager,
		modelRegistry: ctx.modelRegistry,
		model,
		tools: allowedTools,
		resourceLoader: loader,
	};
	if (thinkingLevel) {
		sessionOptions.thinkingLevel = thinkingLevel;
	}

	const { session } = await createAgentSession(sessionOptions);
	const baseSessionName = agentConfig?.name ?? type;
	session.setSessionName(options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName);
	await session.bindExtensions({
		onError: (error) => {
			options.onToolActivity?.({ type: "end", toolName: `extension-error:${error.extensionPath}` });
		},
	});
	options.onSessionCreated?.(session);

	let turnCount = 0;
	const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
	let softLimitReached = false;
	let aborted = false;
	let currentMessageText = "";
	const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_end") {
			turnCount++;
			options.onTurnEnd?.(turnCount);
			if (maxTurns != null) {
				if (!softLimitReached && turnCount >= maxTurns) {
					softLimitReached = true;
					session.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now.");
				} else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
					aborted = true;
					session.abort();
				}
			}
		}
		if (event.type === "message_start") {
			currentMessageText = "";
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			currentMessageText += event.assistantMessageEvent.delta;
			options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
		}
		if (event.type === "tool_execution_start") {
			options.onToolActivity?.({ type: "start", toolName: event.toolName });
		}
		if (event.type === "tool_execution_end") {
			options.onToolActivity?.({ type: "end", toolName: event.toolName });
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = event.message.usage;
			if (usage) {
				options.onAssistantUsage?.({ input: usage.input ?? 0, output: usage.output ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
			}
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
		}
	});

	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);
	let effectivePrompt = prompt;
	if (options.inheritContext) {
		const parentContext = buildParentContext(ctx);
		if (parentContext) {
			effectivePrompt = parentContext + prompt;
		}
	}

	try {
		await session.prompt(effectivePrompt);
	} finally {
		unsubTurns();
		collector.unsubscribe();
		cleanupAbort();
	}

	const responseText = collector.getText().trim() || getLastAssistantText(session);
	return { responseText, session, aborted, steered: softLimitReached };
}

export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		onToolActivity?: (activity: ToolActivity) => void;
		onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
		onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
		signal?: AbortSignal;
	} = {},
): Promise<string> {
	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);
	const unsubEvents = options.onToolActivity || options.onAssistantUsage || options.onCompaction
		? session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "tool_execution_start") {
				options.onToolActivity?.({ type: "start", toolName: event.toolName });
			}
			if (event.type === "tool_execution_end") {
				options.onToolActivity?.({ type: "end", toolName: event.toolName });
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				const usage = event.message.usage;
				if (usage) {
					options.onAssistantUsage?.({ input: usage.input ?? 0, output: usage.output ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
				}
			}
			if (event.type === "compaction_end" && !event.aborted && event.result) {
				options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
			}
		})
		: () => {};

	try {
		await session.prompt(prompt);
	} finally {
		collector.unsubscribe();
		unsubEvents();
		cleanupAbort();
	}

	return collector.getText().trim() || getLastAssistantText(session);
}
