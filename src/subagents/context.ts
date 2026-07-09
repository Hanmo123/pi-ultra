import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is { type: string; text?: string } => part?.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

export function buildParentContext(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	if (!entries || entries.length === 0) {
		return "";
	}

	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				const text = extractText(message.content).trim();
				if (text) {
					parts.push(`[User]: ${text}`);
				}
			} else if (message.role === "assistant") {
				const text = extractText(message.content).trim();
				if (text) {
					parts.push(`[Assistant]: ${text}`);
				}
			}
		} else if (entry.type === "compaction" && entry.summary) {
			parts.push(`[Summary]: ${entry.summary}`);
		}
	}

	if (parts.length === 0) {
		return "";
	}

	return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
