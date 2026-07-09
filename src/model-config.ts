import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiUltraModelChoice {
	usage: string;
	model: string;
}

export const PI_ULTRA_CHOICES_KEY = "pi-ultra-choices";
export const PI_ULTRA_MODELS_PATH = join(homedir(), ".pi", "agent", "models.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parsePiUltraModelChoices(value: unknown): PiUltraModelChoice[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry.usage !== "string" || typeof entry.model !== "string") {
			return [];
		}

		const usage = entry.usage.trim();
		const model = entry.model.trim();
		if (!usage || !model) {
			return [];
		}

		return [{ usage, model }];
	});
}

export async function loadPiUltraModelChoices(): Promise<PiUltraModelChoice[]> {
	try {
		const content = await readFile(PI_ULTRA_MODELS_PATH, "utf8");
		const config: unknown = JSON.parse(content);
		if (!isRecord(config)) {
			return [];
		}
		return parsePiUltraModelChoices(config[PI_ULTRA_CHOICES_KEY]);
	} catch {
		return [];
	}
}

export function formatPiUltraModelChoices(choices: readonly PiUltraModelChoice[]): string {
	return choices.map((choice) => `- ${choice.usage} => ${choice.model}`).join("\n");
}
