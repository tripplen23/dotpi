/**
 * triage — routes a user request to a tier before anything is spawned.
 *
 * Engine chain, in order:
 *   0. Crumb short-circuit                 — "ok" / "ship it" needs no decision at all.
 *   1. Jev (TypeSafe, via OpenRouter)      — the decision model. ~480ms, 10/10.
 *   2. Laya (self-hosted, Jev-compatible)  — also a trained model, just slower (~5.8s).
 *   3. Local regex hint                    — not a classifier; see below.
 *
 * The regex is deliberately LAST, and it is no longer allowed to produce a `Triage
 * Result` at all. A hardcoded rule only matches phrasings we anticipated, so it can
 * never be more robust than a model — and robustness is the whole reason to have a
 * decision model. Our own benchmark flattered it (10/10) because those rules were
 * written while looking at those ten prompts: that measures fit, not generalisation.
 * When no model answers, the tool says so and hands the keyword match over as an
 * explicitly unreliable hint, so the orchestrator applies the AGENTS.md rules itself.
 * A guess presented as a result is worse than no result, and it must never consume an
 * ask_user_question.
 *
 * Two engine differences this file has to absorb:
 *   - Laya returns `answer_confidence` (P of the reported answer) AND `confidence`
 *     (1 - normalised entropy). Jev returns only `confidence`, which already means
 *     P(answer). So read `answer_confidence ?? confidence`.
 *   - Jev omits confidence entirely on `noul` answers. Missing must mean "confident",
 *     the way ultimate-pi treats it; a naive port would drop every QA and review route.
 *
 * The routing decision is returned as text, so AGENTS.md only needs one line telling
 * the orchestrator to call this tool first. The policy lives here, in code.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	minConfidenceFor,
	QUESTIONS,
} from "./questions.ts";
import { compose, verificationOf, type Answers } from "./compose.ts";
import { classifyHeuristic, isContinuationCrumb, type Verification } from "./fallback.ts";

const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const JEV_MODEL = "jev-1.13";
const JEV_TIMEOUT_MS = 2_500; // measured ~350ms; fail over fast
const LAYA_TIMEOUT_MS = 9_000; // measured ~5.8s for this 4-question set on the CPU box

const PRIOR_MAX = 800;
const PRIOR_ATTACH_MAX = 240;

/** Tiers that only exist after composing the two nouls with the choice. */
const ROUTE: Record<string, { agent: string; route: string }> = {
	tier_0: { agent: "—", route: "Answer directly in this session. Do not spawn anything." },
	tier_1: { agent: "worker", route: "subagent({ agent: \"worker\", … })" },
	tier_2: {
		agent: "scout → worker",
		route: "subagent({ agent: \"scout\", … }) for the file/line map, then hand that map to subagent({ agent: \"worker\", … })",
	},
	tier_3: {
		agent: "planner → worker",
		route: `subagent({ agent: "planner", … }) — it writes a spec to .pi/plans/<slug>.md. Show that spec to the user before spawning workers.`,
	},
	tier_4_qa: { agent: "qa", route: "subagent({ agent: \"qa\", … })" },
	tier_5_review: { agent: "reviewer", route: "subagent({ agent: \"reviewer\", … })" },
};

const VERIFY_TEXT: Record<Verification, string> = {
	tests: "the worker's own tests are the check",
	scout: "re-read the changed logic with subagent({ agent: \"scout\" })",
	browser: "verify in a running UI with subagent({ agent: \"qa\" })",
	reviewer: "get a verdict from subagent({ agent: \"reviewer\" })",
};

/** Read a KEY=value file without touching the shell. Empty result on any error. */
function readEnvFile(path: string): Record<string, string> {
	try {
		const out: Record<string, string> = {};
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
			if (!m) continue;
			out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * OpenRouter credential for Jev, resolved the way Pi resolves credentials
 * everywhere else: an explicit env var wins, then Pi's own credential store —
 * which is what `/login` writes — and only then a KEY=value file some setups keep
 * beside the Laya credentials. Nothing here needs env.sh.
 */
async function resolveOpenRouter(ctx: ExtensionContext): Promise<string | undefined> {
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	try {
		const key = await ctx.modelRegistry?.getApiKeyForProvider?.("openrouter");
		if (key?.trim()) return key.trim();
	} catch {
		/* provider not configured, or the lookup failed: fall through */
	}

	return readEnvFile(join(process.env.HOME ?? "", ".config", "laya", "env")).OPENROUTER_API_KEY;
}

/** Laya endpoint and bearer. No Pi-side equivalent, so env then the Laya env file. */
function layaConfig() {
	const file = readEnvFile(join(process.env.HOME ?? "", ".config", "laya", "env"));
	const pick = (k: string) => process.env[k]?.trim() || file[k] || undefined;
	return { layaUrl: pick("LAYA_URL"), layaKey: pick("LAYA_API_KEY") };
}



function lastUserText(entry: unknown): string {
	const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
	if (e?.type !== "message" || e.message?.role !== "user") return "";
	const c = e.message.content;
	if (typeof c === "string") return c.trim();
	if (!Array.isArray(c)) return "";
	return c
		.filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

const CONTINUATION = /^(alright|all right|one more|also[, ]|instead |now,|ok so |and also|ship it)/i;

/** The classifier has no conversation; hand it the previous turn when it looks needed. */
function priorRequest(ctx: ExtensionContext, current: string): string | undefined {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
	const trimmed = current.trim();
	if (trimmed.length > PRIOR_ATTACH_MAX && !CONTINUATION.test(trimmed)) return undefined;
	const users: string[] = [];
	for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
		const text = lastUserText(entry);
		if (text && norm(text) !== norm(current)) users.push(text);
	}
	const prior = users.at(-1);
	return prior ? prior.slice(0, PRIOR_MAX) : undefined;
}

async function askJev(prompt: string, prior: string | undefined, key: string) {
	const r = await fetch(JEV_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model: JEV_MODEL,
			state: prior ? { request: prompt, prior_request: prior } : { request: prompt },
			questions: QUESTIONS,
		}),
		signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const d = (await r.json()) as { answers?: Answers; usage?: { cost?: number } };
	if (!d.answers?.task_tier && !d.answers?.is_ui_test && !d.answers?.is_code_review) throw new Error("malformed body");
	return { answers: d.answers, cost: d.usage?.cost };
}

async function askLaya(prompt: string, prior: string | undefined, url: string, key: string) {
	const r = await fetch(`${url.replace(/\/$/, "")}/systemone`, {
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			state: prior ? { request: prompt, prior_request: prior } : { request: prompt },
			questions: QUESTIONS,
		}),
			signal: AbortSignal.timeout(LAYA_TIMEOUT_MS),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const d = (await r.json()) as { answers?: Answers };
	if (!d.answers?.task_tier && !d.answers?.is_ui_test && !d.answers?.is_code_review) throw new Error("malformed body");
	return { answers: d.answers };
}

export default function (pi: ExtensionAPI) {
	const trace = (row: Record<string, unknown>) => {
		try {
			appendFileSync(join(getAgentDir(), "triage.log"), JSON.stringify(row) + "\n");
		} catch {
			/* tracing must never break routing */
		}
	};

	pi.registerTool({
		name: "triage",
		label: "Triage",
		description:
			"Classify the user's exact request into a routing tier before doing any work. " +
			"Pass the user's wording verbatim — do not rewrite, summarise, or translate it. " +
			"Returns the tier, a confidence, the verification level, and the exact route to take " +
			"(which subagent to spawn). Call this once at the start of a request that may need work done.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The user's exact request string, verbatim" }),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) return { content: [{ type: "text", text: "triage: empty prompt." }], details: {} };

			const prior = priorRequest(ctx, prompt);
			const { layaUrl, layaKey } = layaConfig();
			const openrouter = await resolveOpenRouter(ctx);
			const warnings: string[] = [];
			const started = Date.now();
			let source = ""; // always set below; never default to the regex
			let tier = "";
			let confidence: number | undefined;
			let verification: Verification = "tests";

			// A continuation crumb needs no decision: no engine is consulted.
			if (isContinuationCrumb(prompt)) {
				tier = "tier_0";
				confidence = 1;
				source = "crumb";
			} else {
				// 1. Jev — the decision model. Most accurate and fastest (measured 482ms).
				if (openrouter) {
					try {
						const answers = (await askJev(prompt, prior, openrouter)).answers;
						const c = compose(answers);
						if (c.tier !== "unknown") {
							tier = c.tier;
							confidence = c.confidence;
							verification = verificationOf(answers, tier);
							source = "jev";
						} else {
							warnings.push("Jev returned no usable tier");
						}
					} catch (e) {
						warnings.push(`Jev unavailable (${(e as Error).message})`);
					}
				} else {
					warnings.push("no OpenRouter credential (env or pi login)");
				}

				// 2. Laya — also a trained model, self-hosted. Slower (~5.8s) and weaker on
				//    our set, but it generalises where a regex cannot, so it outranks one.
				if (!tier) {
					if (layaUrl && layaKey) {
						try {
							const answers = (await askLaya(prompt, prior, layaUrl, layaKey)).answers;
							const c = compose(answers);
							if (c.tier !== "unknown") {
								tier = c.tier;
								confidence = c.confidence;
								verification = verificationOf(answers, tier);
								source = "laya";
							}
						} catch (e) {
							warnings.push(`Laya unavailable (${(e as Error).message})`);
						}
					} else {
						warnings.push("Laya not configured (LAYA_URL/LAYA_API_KEY)");
					}
				}

				// 3. Local regex — last resort. Hardcoded rules only match phrasings we
				//    anticipated, so this is a fallback, never a first choice.
				if (!tier) {
					const fb = classifyHeuristic(prompt);
					tier = fb.tier;
					confidence = fb.confidence;
					verification = fb.verification;
					source = "heuristic";
					if (!fb.matched) warnings.push("no keyword rule matched — this is a guess, not a classification");
				}
			}

			const pct = confidence === undefined ? undefined : Math.round(confidence * 100);
			const route = ROUTE[tier] ?? ROUTE.tier_1!;
			// Only a model's answer can be low-confidence. A regex match is not a
			// classification, so it must never consume an ask_user_question.
			const flagged = source !== "heuristic" && pct !== undefined && pct < minConfidenceFor(tier);

			const lines: string[] = [];
			if (source === "crumb") {
				lines.push("Triage Result: tier_0 — continuation crumb, nothing to classify.");
			} else if (source === "heuristic") {
				// No model answered. Say so plainly rather than dressing a keyword match up
				// as a decision: a guess presented as a result is worse than no result.
				lines.push(`No classifier available — ${warnings.join("; ") || "no engine answered"}.`);
				lines.push("Apply the routing rules in AGENTS.md yourself; do not ask the user to confirm this.");
				lines.push(`Keyword hint only, no accuracy claim: ${tier}.`);
			} else {
				lines.push(`Triage Result: ${tier}${pct === undefined ? "" : ` (confidence ${pct}%)`} — via ${source}`);
				if (flagged) {
					lines.push("WARNING: low confidence. Confirm the tier with the user via ask_user_question BEFORE routing.");
				}
				if (warnings.length) lines.push(`Fallback note: ${warnings.join("; ")}`);
			}
			lines.push(`Route: ${route.route}`);
			lines.push(`Agent: ${route.agent}`);
			lines.push(`Verification: ${verification} — ${VERIFY_TEXT[verification]}`);

			trace({ at: new Date().toISOString(), tier, confidence: pct, verification, source, ms: Date.now() - started, warnings, prompt: prompt.slice(0, 300) });

			return { content: [{ type: "text", text: lines.join("\n") }], details: { tier, confidence: pct, verification, source } };
		},
	});
}
