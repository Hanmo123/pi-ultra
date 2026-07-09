import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;
type ModelRegistry = ExtensionContext["modelRegistry"];

export function resolveModel(input: string, registry: ModelRegistry): Model | string {
	const all = registry.getAvailable?.() ?? registry.getAll();
	const availableSet = new Set(all.map((model) => `${model.provider}/${model.id}`.toLowerCase()));

	const slashIdx = input.indexOf("/");
	if (slashIdx !== -1 && availableSet.has(input.toLowerCase())) {
		const provider = input.slice(0, slashIdx);
		const modelId = input.slice(slashIdx + 1);
		const found = registry.find(provider, modelId);
		if (found) {
			return found;
		}
	}

	const normalize = (value: string) => value.toLowerCase().replace(/\./g, "-");
	const query = normalize(input);
	let bestMatch: Model | undefined;
	let bestScore = 0;

	for (const model of all) {
		const id = normalize(model.id);
		const name = normalize(model.name);
		const full = normalize(`${model.provider}/${model.id}`);
		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else if (query.split(/[\s\-/]+/).every((part) => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || model.provider.toLowerCase().includes(part))) {
			score = 20;
		}
		if (score > bestScore) {
			bestScore = score;
			bestMatch = model;
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id);
		if (found) {
			return found;
		}
	}

	if (slashIdx !== -1) {
		const bare = resolveModel(input.slice(slashIdx + 1), registry);
		if (typeof bare !== "string") {
			return bare;
		}
	}

	const modelList = all.map((model) => `  ${model.provider}/${model.id}`).sort().join("\n");
	return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
