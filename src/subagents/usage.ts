export interface LifetimeUsage {
	input: number;
	output: number;
	cacheWrite: number;
}

export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
	into.input += delta.input;
	into.output += delta.output;
	into.cacheWrite += delta.cacheWrite;
}
