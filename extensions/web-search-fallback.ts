/**
 * Web Search with provider fallback.
 *
 * Registers one `web_search` tool that tries providers in order and returns the
 * first usable result: Exa → Firecrawl → Playwright (DuckDuckGo HTML).
 *
 * Why: MCP search servers fail for different reasons (Exa free plan → 429 that
 * can hang; Firecrawl → out of credits). This tool hides that and always answers
 * if any provider still works.
 *
 * Add another provider (Tavily, Brave, ...) by appending to PROVIDERS.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Ordered fallback chain. Each entry maps the shared (query, limit) to that tool's args. */
const PROVIDERS = [
	{
		tool: "mcp__exa__web_search_exa",
		// Exa's hosted server requires `objective` (docs still list only query/numResults).
		build: (query: string, limit: number) => ({ query, objective: query, numResults: limit }),
	},
	{
		tool: "mcp__firecrawl__firecrawl_search",
		build: (query: string, limit: number) => ({ query, limit }),
	},
];

const PLAYWRIGHT_NAVIGATE = "mcp__playwright-chrome__browser_navigate";
const PLAYWRIGHT_SNAPSHOT = "mcp__playwright-chrome__browser_snapshot";
const PROVIDER_TIMEOUT_MS = 20_000;

type Outcome = { isError: boolean; result: { content?: Array<{ type: string; text?: string }> } };

function textOf(outcome: Outcome): string {
	return (outcome.result?.content ?? [])
		.filter((b): b is { type: string; text: string } => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/** Empty text or a rate-limit/credit message means: try the next provider. */
function isUsable(text: string, isError: boolean): boolean {
	if (isError || !text) return false;
	return !/429|rate.?limit|out of credits|quota exceeded|insufficient credits/i.test(text);
}

function timeout(ms: number): { signal: AbortSignal; clear: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the web. Tries Exa first, then Firecrawl, then Playwright/DuckDuckGo, and returns the first provider that works. Use this instead of calling a search MCP tool directly unless you need a provider-specific feature.",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 20, description: "Max results (default 5)" }),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const limit = params.limit ?? 5;
		const available = new Set(ctx.tools.map((t) => t.name));
		const errors: string[] = [];

		for (const provider of PROVIDERS) {
			if (!available.has(provider.tool)) {
				errors.push(`${provider.tool}: not available`);
				continue;
			}
			const t = timeout(PROVIDER_TIMEOUT_MS);
			try {
				const outcome = (await ctx.executeTool(provider.tool, provider.build(params.query, limit), {
					signal: t.signal,
					onUpdate,
				})) as Outcome;
				const text = textOf(outcome);
				if (isUsable(text, outcome.isError)) {
					return {
						content: [{ type: "text", text: `[via ${provider.tool}]\n${text}` }],
						details: { provider: provider.tool },
					};
				}
				errors.push(`${provider.tool}: ${outcome.isError ? text || "error" : "empty"}`);
			} catch (error) {
				errors.push(`${provider.tool}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				t.clear();
			}
		}

		// Last resort: no search API, drive a browser to DuckDuckGo's no-JS page.
		if (available.has(PLAYWRIGHT_NAVIGATE)) {
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
			try {
				const nav = (await ctx.executeTool(PLAYWRIGHT_NAVIGATE, { url }, { signal })) as Outcome;
				if (!nav.isError) {
					const snap = (await ctx.executeTool(PLAYWRIGHT_SNAPSHOT, {}, { signal })) as Outcome;
					const text = textOf(snap) || textOf(nav);
					if (text) {
						return {
							content: [{ type: "text", text: `[via ${PLAYWRIGHT_NAVIGATE}]\n${text}` }],
							details: { provider: PLAYWRIGHT_NAVIGATE },
						};
					}
				}
				errors.push(`${PLAYWRIGHT_NAVIGATE}: ${textOf(nav) || "no result"}`);
			} catch (error) {
				errors.push(`${PLAYWRIGHT_NAVIGATE}: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			errors.push(`${PLAYWRIGHT_NAVIGATE}: not available`);
		}

		return {
			content: [{ type: "text", text: `All search providers failed:\n${errors.join("\n")}` }],
			details: { errors },
			isError: true,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
}
