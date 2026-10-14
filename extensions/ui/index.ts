/**
 * dotpi UI pack — tetris-style banner, boxed editor with the session stats in
 * its border, and a gradient working indicator.
 *
 * The footer is replaced by a status-only footer. Pi's built-in footer spends
 * three rows on cwd, token totals, cost, context and model; all of that now
 * lives in the editor border, so the footer is trimmed to just the extension
 * statuses (bash-guard's BG-OFF badge, pi-talk's listening indicator, …) and
 * collapses to nothing when there are none.
 *
 * Everything here uses theme tokens, so switching theme re-colours all of it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Pi's own logo mark — see packages/coding-agent/src/modes/interactive/components/
// pi-logo.ts and easter-egg-3d.ts. Two terminal cells per pixel keeps every block
// square, since a cell is roughly twice as tall as it is wide. Pi hardcodes these
// three colours for its wordmark too rather than taking them from the theme.
const LOGO_PIXELS = ["ccc.", "b.c.", "bb.y", "b..y"];
const LOGO_COLORS: Record<string, string> = {
	c: "\x1b[38;2;228;138;122m", // coral
	b: "\x1b[38;2;79;142;179m", // blue
	y: "\x1b[38;2;234;182;93m", // yellow
};
const LOGO_RESET = "\x1b[39m";

const logoRow = (row: string): string =>
	[...row].map((px) => (px === "." ? "  " : `${LOGO_COLORS[px]}██${LOGO_RESET}`)).join("");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const fmt = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

const fmtCwd = (cwd: string): string => {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
};

type RGB = [number, number, number];

//
// Liquid gold: the bar is a metal ramp, not a flat fill. Filled cells run
// shadow → sheen across the bar, and the whole ramp heats up (gold → amber →
// vermilion) as the window fills, so the colour is the signal too.
// Truecolor, like the banner; on a 256-colour terminal it degrades badly.
const RAMP_GOLD = { from: [168, 132, 42], to: [255, 248, 220] } as const; // #a8842a → #fff8dc
const RAMP_WARM = { from: [224, 178, 60], to: [232, 147, 63] } as const; // #e0b23c → #e8933f
const RAMP_HOT = { from: [232, 147, 63], to: [224, 97, 63] } as const; // #e8933f → #e0613f
const BAR_TRACK: RGB = [61, 42, 20]; // #3d2a14

const mix = (a: readonly number[], b: readonly number[], t: number): RGB => [
	Math.round(a[0]! + (b[0]! - a[0]!) * t),
	Math.round(a[1]! + (b[1]! - a[1]!) * t),
	Math.round(a[2]! + (b[2]! - a[2]!) * t),
];
const fgRgb = (c: RGB): string => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const RESET = "\x1b[39m";

function ctxBar(percent: number, cells: number): string {
	const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
	const ramp = percent >= 85 ? RAMP_HOT : percent >= 60 ? RAMP_WARM : RAMP_GOLD;
	let out = "";
	for (let i = 0; i < filled; i++) {
		const t = filled <= 1 ? 1 : i / (filled - 1);
		out += fgRgb(mix(ramp.from, ramp.to, t)) + "█";
	}
	if (filled < cells) out += RESET + fgRgb(BAR_TRACK) + "░".repeat(cells - filled);
	return out + RESET;
}

/** What is configured, not what is loaded — the two differ only after an edit. */
interface Counts {
	skills: number;
	mcp: number;
	extensions: number;
}

const countSubdirs = (dir: string): number => {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
	} catch {
		return 0;
	}
};

/**
 * Reads the same places Pi discovers from. The extension count mirrors Pi's rule
 * (top-level `.ts`/`.js` files, plus subdirectories with an `index.ts`/`index.js`),
 * so it can drift if Pi changes how it discovers extensions.
 */
function readCounts(mcp: number): Counts {
	const home = process.env.HOME ?? "";
	const agentDir = getAgentDir();
	const extDir = join(agentDir, "extensions");
	let extensions = 0;
	try {
		for (const e of readdirSync(extDir, { withFileTypes: true })) {
			if (e.name.startsWith(".")) continue;
			if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) extensions++;
			else if (e.isDirectory() && (existsSync(join(extDir, e.name, "index.ts")) || existsSync(join(extDir, e.name, "index.js"))))
				extensions++;
		}
	} catch {
		/* no extensions dir: report 0 */
	}
	return {
		skills: countSubdirs(join(home, ".agents", "skills")) + countSubdirs(join(agentDir, "skills")),
		mcp,
		extensions,
	};
}

type Totals = { input: number; output: number; cost: number };

/** Session-wide usage, mirroring what pi's built-in footer reports. */
function sessionTotals(ctx: ExtensionContext): Totals {
	const t: Totals = { input: 0, output: 0, cost: 0 };
	const add = (u: { input?: number; output?: number; cost?: { total?: number } }) => {
		t.input += u.input ?? 0;
		t.output += u.output ?? 0;
		t.cost += u.cost?.total ?? 0;
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			add(entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			add(entry.message.usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage);
		}
	}
	return t;
}

/**
 * Draw `left` and `right` between two corner glyphs, shrinking to fit `width`.
 * Pi's editor border is a bare run of "─" with no corners, so we supply them.
 */
function rule(left: string, right: string, width: number, corners: [string, string], border: (t: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");
	let l = left;
	let r = right;
	const fixed = 2; // the two corners
	const minGap = 3;
	while (fixed + visibleWidth(l) + visibleWidth(r) + minGap > width && visibleWidth(r) > 0) {
		r = truncateToWidth(r, Math.max(0, visibleWidth(r) - 1), "");
	}
	while (fixed + visibleWidth(l) + visibleWidth(r) + minGap > width && visibleWidth(l) > 0) {
		l = truncateToWidth(l, Math.max(0, visibleWidth(l) - 1), "");
	}
	const gap = Math.max(0, width - fixed - visibleWidth(l) - visibleWidth(r));
	return `${border(corners[0])}${l}${border("─".repeat(gap))}${r}${border(corners[1])}`;
}

export default function (pi: ExtensionAPI) {
	let active: ExtensionContext | undefined;
	let footerData: ReadonlyFooterDataProvider | undefined;
	let counts: Counts = { skills: 0, mcp: 0, extensions: 0 };

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		active = ctx;
		counts = readCounts(pi.getMcpServers?.().length ?? 0);

		// --- banner ---------------------------------------------------------
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const thinking = pi.getThinkingLevel();
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
				const branch = footerData?.getGitBranch();
				const info = [
					theme.fg("text", "dotpi") + theme.fg("dim", `  ·  pi ${VERSION}`),
					theme.fg("muted", `${model}${thinking === "off" ? "" : ` · ${thinking}`}`),
					theme.fg("dim", `${fmtCwd(ctx.cwd)}${branch ? ` · ${branch}` : ""}`),
				];
				const lines = LOGO_PIXELS.map((row, i) =>
					truncateToWidth(`${logoRow(row)}   ${info[i] ?? ""}`, width, ""),
				);
				return [...lines, ""];
			},
		}));

		// --- footer: extension statuses only ---------------------------------
		ctx.ui.setFooter((tui, theme, data) => {
			footerData = data;
			const unsub = data.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const statuses = [...data.getExtensionStatuses().values()];
					if (statuses.length === 0) return [];
					return [truncateToWidth(statuses.join(theme.fg("dim", "   ·   ")), width, "")];
				},
			};
		});

		// --- editor: rounded box with the session stats in its border --------
		class StatusEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length < 2) return lines;

				const thm = ctx.ui.theme;
				const border = (t: string) => this.borderColor(t);
				const thinking = pi.getThinkingLevel();
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";

				const chip = thm.style(" π ", {
					fg: thm.colors.toolPendingBg,
					bg: thm.colors.accent,
					bold: true,
				});
				lines[0] = rule(
					`${chip}${thm.fg("muted", " ")}`,
					thm.fg("muted", `${model}${thinking === "off" ? "" : ` · ${thinking}`} `),
					width,
					["╭", "╮"],
					border,
				);

				// Right side: stats (droppable) + context bar (always kept).
				const t = sessionTotals(ctx);
				const usage = ctx.getContextUsage();
				const percent = usage?.percent ?? null;
				const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const auto = (pi.getSettings().compaction?.enabled ?? true) ? " (auto)" : "";
				const tail =
					percent === null
						? thm.fg("dim", ` ?/${fmt(window)}${auto} `)
						: ` ${ctxBar(percent, 8)}${thm.fg("muted", ` ${percent.toFixed(1)}%/${fmt(window)}${auto} `)}`;

				// Droppable right-hand segments; the lowest `keep` goes first, so cost and
				// the configured counts survive a narrow terminal.
				const pool: Array<{ text: string; keep: number }> = [];
				if (t.cost) pool.push({ text: thm.fg("accent", `$${t.cost.toFixed(3)}`), keep: 6 });
				if (counts.skills) pool.push({ text: `${counts.skills} skills`, keep: 5 });
				if (counts.mcp) pool.push({ text: `${counts.mcp} mcp`, keep: 4 });
				if (counts.extensions) pool.push({ text: `${counts.extensions} ext`, keep: 3 });
				if (t.input) pool.push({ text: `↑${fmt(t.input)}`, keep: 2 });
				if (t.output) pool.push({ text: `↓${fmt(t.output)}`, keep: 1 });

				const left = thm.fg("muted", ` ${fmtCwd(ctx.cwd)}${footerData?.getGitBranch() ? ` · ${footerData.getGitBranch()}` : ""} `);
				const build = () => [...pool.map((s) => s.text), tail].join("  ");
				while (pool.length > 0 && visibleWidth(left) + visibleWidth(build()) + 5 > width) {
					let lowest = 0;
					for (let i = 1; i < pool.length; i++) if (pool[i]!.keep < pool[lowest]!.keep) lowest = i;
					pool.splice(lowest, 1);
				}

				lines[lines.length - 1] = rule(left, build(), width, ["╰", "╯"], border);
				return lines;
			}
		}
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new StatusEditor(tui, theme, keybindings));

		// --- working indicator ------------------------------------------------
		ctx.ui.setWorkingIndicator({
			frames: SPINNER.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 80,
		});
	});

	pi.on("session_shutdown", () => {
		if (!active) return;
		active.ui.setHeader(undefined);
		active.ui.setFooter(undefined);
		active.ui.setEditorComponent(undefined);
		active.ui.setWorkingIndicator();
	});

	pi.registerCommand("theme", {
		description: "Switch theme. /theme picks from a list; /theme <name> switches directly.",
		handler: async (args, ctx) => {
			const all = ctx.ui.getAllThemes();
			if (all.length === 0) {
				ctx.ui.notify("No themes found.", "warning");
				return;
			}

			// `old-money` reads better as "Old Money" in a dialog, but the on-disk name
			// stays kebab-case: it is also the filename and the --use-theme value.
			const pretty = (n: string) =>
				n
					.replace(/[-_]/g, " ")
					.replace(/\b\w/g, (c) => c.toUpperCase());

			const direct = args.trim();
			let name = direct;

			if (!name) {
				const current = ctx.ui.theme.name ?? "";
				const byLabel = new Map(all.map((t) => [pretty(t.name), t.name]));
				// Put the active theme first so the dialog opens showing where you are.
				const ordered = all.map((t) => t.name);
				const at = ordered.indexOf(current);
				if (at > 0) ordered.splice(0, 0, ...ordered.splice(at, 1));

				const picked = await ctx.ui.select(
					`Theme — current: ${pretty(current)}`,
					ordered.map(pretty),
				);
				if (!picked) return;
				name = byLabel.get(picked) ?? picked;
			}

			const result = ctx.ui.setTheme(name);
			if (result.success) ctx.ui.notify(`Theme: ${pretty(name)}`, "info");
			else ctx.ui.notify(`Could not switch to "${name}": ${result.error ?? "unknown error"}`, "error");
		},
	});

	pi.registerCommand("dotpi-ui", {
		description: "Turn the dotpi UI pack off for this session (banner, boxed editor, spinner).",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setWorkingIndicator();
			ctx.ui.notify("dotpi UI off. Run /reload to bring it back.", "info");
		},
	});
}
