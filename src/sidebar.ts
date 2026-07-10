import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentManager, SubagentSidebarRecord } from "./subagent-manager.ts";

const SIDEBAR_WIDTH = "33%";
const SIDEBAR_MIN_WIDTH = 34;
const SIDEBAR_MAX_HEIGHT = "100%";
const SIDEBAR_GUTTER = 1;

interface SidebarTui {
	requestRender(force?: boolean): void;
	terminal?: { rows?: number };
}

interface SidebarOverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
}

interface SidebarComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

function fit(text: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	if (text.length > width) {
		if (width <= 3) {
			return text.slice(0, width);
		}
		return `${text.slice(0, width - 3)}...`;
	}
	return `${text}${" ".repeat(width - text.length)}`;
}

function previewFallback(record: SubagentSidebarRecord): string {
	if (record.status === "queued") {
		return "(queued)";
	}
	if (record.status === "running" || record.status === "steered") {
		return "(waiting for output)";
	}
	if (record.status === "error") {
		return "(subagent failed)";
	}
	return "(no output)";
}

class LeaderSidebarComponent implements SidebarComponent {
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: SidebarTui,
		private readonly theme: Theme,
		private readonly manager: SubagentManager,
	) {
		this.unsubscribe = this.manager.subscribeSidebar(() => {
			this.tui.requestRender();
		});
	}

	private frame(lines: string[], width: number): string[] {
		const frameWidth = Math.max(4, width - SIDEBAR_GUTTER);
		const innerWidth = Math.max(1, frameWidth - 4);
		const bodyHeight = Math.max(lines.length, (this.tui.terminal?.rows ?? 24) - 2);
		const paddedLines = [...lines, ...Array.from({ length: Math.max(0, bodyHeight - lines.length) }, () => "")];
		const gutter = " ".repeat(SIDEBAR_GUTTER);
		const border = `${gutter}${this.theme.fg("border", `+${"-".repeat(innerWidth + 2)}+`)}`;
		return [
			border,
			...paddedLines.map((line) => `${gutter}${this.theme.fg("border", "| ")}${fit(line, innerWidth)}${this.theme.fg("border", " |")}`),
			border,
		];
	}

	private renderRecord(record: SubagentSidebarRecord): string[] {
		const heading = `[${record.status}] ${record.label ?? record.id.slice(0, 8)}`;
		const meta = `${record.subagentType} turns ${record.turnCount}`;
		const tool = record.currentTool ? `tool ${record.currentTool}` : record.lastTool ? `last ${record.lastTool}` : "";
		const branch = record.branch ? `branch ${record.branch}` : "";
		const preview = record.previewLines.length > 0 ? record.previewLines : [previewFallback(record)];

		return [
			heading,
			record.description,
			meta,
			...(branch ? [branch] : []),
			...(tool ? [tool] : []),
			...preview.map((line) => `> ${line}`),
		];
	}

		render(width: number): string[] {
		const records = this.manager.listSidebarRecords();
		const running = records.filter((record) => record.status === "running").length;
		const queued = records.filter((record) => record.status === "queued").length;
		const finished = records.filter((record) => record.status === "completed").length;
		const rows = this.tui.terminal?.rows ?? 24;
		const maxLines = Math.max(12, rows - 4);
		const lines: string[] = [
			"Leader Sidebar",
			`running ${running}  queued ${queued}  done ${finished}`,
			`subagents ${records.length}`,
			"",
		];

		if (records.length === 0) {
			lines.push("(no subagents yet)");
			return this.frame(lines, width);
		}

		let rendered = 0;
		for (const record of records) {
			const block = this.renderRecord(record);
			const extraGap = rendered === 0 ? 0 : 1;
			if (lines.length + block.length + extraGap + 1 > maxLines) {
				break;
			}
			if (rendered > 0) {
				lines.push("");
			}
			lines.push(...block);
			rendered++;
		}

		if (rendered < records.length) {
			lines.push("");
			lines.push(`... ${records.length - rendered} more`);
		}

		return this.frame(lines, width);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}

export class LeaderSidebarController {
	private enabled: boolean;
	private overlayHandle: SidebarOverlayHandle | undefined;
	private component: LeaderSidebarComponent | undefined;
	private showPromise: Promise<unknown> | undefined;

	constructor(private readonly manager: SubagentManager, enabled = true) {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.overlayHandle?.setHidden(!enabled);
	}

	statusText(mode: ExtensionContext["mode"]): string {
		const visibility = this.enabled ? "enabled" : "disabled";
		const scope = mode === "tui" ? "overlay" : `no sidebar in ${mode}`;
		return `Leader sidebar ${visibility}. Mode: ${scope}.`;
	}

	attachToSession(ctx: ExtensionContext): void {
		this.disposeOverlay();
		if (ctx.mode !== "tui") {
			return;
		}
		this.showPromise = ctx.ui.custom<void>(
			(tui, theme, _kb, _done) => {
				this.component = new LeaderSidebarComponent(tui as SidebarTui, theme, this.manager);
				return this.component;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: SIDEBAR_WIDTH,
					minWidth: SIDEBAR_MIN_WIDTH,
					maxHeight: SIDEBAR_MAX_HEIGHT,
					margin: 0,
					nonCapturing: true,
				},
				onHandle: (handle) => {
					this.overlayHandle = handle as SidebarOverlayHandle;
					this.overlayHandle.setHidden(!this.enabled);
				},
			},
		).catch(() => {
			this.disposeOverlay();
		});
	}

	disposeOverlay(): void {
		this.component?.dispose?.();
		this.component = undefined;
		this.overlayHandle?.hide();
		this.overlayHandle = undefined;
		this.showPromise = undefined;
	}
}
