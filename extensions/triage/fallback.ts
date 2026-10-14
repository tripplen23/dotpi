/**
 * Last-resort keyword classifier.
 *
 * Runs only when neither Jev nor Laya answers. It is NOT a decision model and not
 * a substitute for one: confidence is hard-capped at 0.6, which is below the 0.7
 * floor for tier_3 / tier_4_qa / tier_5_review, so a heuristic plan, QA or audit
 * classification always surfaces as a low-confidence warning the orchestrator has
 * to confirm with the user.
 *
 * Confidence is a fraction in 0..1, the same units the engines report, so the call
 * site never has to know which path produced the number.
 *
 * Ordering matters and mirrors ultimate-pi's: audit wording is checked BEFORE plan
 * wording, so "architecture audit" is a review; bare "review" is not matched at
 * all, so "review the plan" falls through to the plan rule.
 */

export type Verification = "tests" | "scout" | "browser" | "reviewer";

export interface HeuristicResult {
	tier: string;
	confidence: number; // 0..1
	verification: Verification;
	/** False only on the no-rule-matched default. The caller uses this to decide
	 *  whether a trained model (Laya) is worth asking before accepting the guess. */
	matched: boolean;
}

const CEILING = 0.6;

const CRUMB =
	/^(ok|okay|k|yep|yes|yeah|sure|go|go on|continue|carry on|proceed|ship it|do it|alright|all right|thanks|thank you|lgtm|nice|cool|good|👍)[.! ]*$/i;

/** Read-only assessment wording. Checked before plan wording on purpose. */
const REVIEW = /\b(code audit|project audit|security review|adversarial review|audit)\b/i;

/** Operating a running UI. */
const UI_VERIFY =
	/\b(click through|test the .{0,20}(page|flow|form)|in the browser|use the browser|playwright|simulator|take over my browser|e2e|screenshot the)\b/i;

/**
 * Openers that mean "answer me, do not touch the repo". Deliberately excludes
 * "when" and "who": "when I click x I get an empty list" is a bug report, not a
 * question, and must fall through to the fix rule.
 */
const ASK = /^(what|why|how do i|how does|where|which|explain|show me|tell me|is there|are we|is it|can you explain)\b/i;
const ASK_ANY = /\b(status|documentation|what model|the cli doesn'?t launch|which model)\b/i;

const PLAN =
	/\b(plan|spec|design|architect\w*|refactor|redesign|rewrite|new (page|surface|subsystem|module|feature)|scaffold|migrate|migration)\b|\b(build|create|add|implement)\b.{0,40}\b(page|surface|feature|module|system|service|dashboard|api|endpoint|flow)\b/i;

/** A target is named, so no recon is needed. */
const NAMED =
	/\b(typo|rename|line \d+|src\/[\w./@-]+|[\w-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|sql|css|scss|html|json|yaml|yml|md))\b/i;

const FIX =
	/\b(fix|bug|broken|breaks|error|crash|not working|doesn'?t work|fails?|failing|empty|wrong|missing|slow|stuck)\b/i;

/**
 * A continuation crumb needs no decision at all: "ok", "ship it", "go on" is always
 * answered inline. This is a pre-filter, not a classification, which is why it may
 * run before the engines — there is nothing to classify.
 */
export const isContinuationCrumb = (prompt: string): boolean => CRUMB.test(prompt.trim());

const atMost = (n: number) => Math.min(n, CEILING);

export function classifyHeuristic(prompt: string): HeuristicResult {
	const p = prompt.trim();

	if (CRUMB.test(p)) return { tier: "tier_0", confidence: 1, verification: "tests", matched: true };

	// Driving a UI only counts when it is not really a question.
	if (UI_VERIFY.test(p) && !ASK.test(p))
		return { tier: "tier_4_qa", confidence: atMost(0.6), verification: "browser", matched: true };

	if (REVIEW.test(p))
		return { tier: "tier_5_review", confidence: atMost(0.6), verification: "reviewer", matched: true };

	if (ASK.test(p) || ASK_ANY.test(p))
		return { tier: "tier_0", confidence: atMost(0.55), verification: "tests", matched: true };

	if (PLAN.test(p)) return { tier: "tier_3", confidence: atMost(0.58), verification: "tests", matched: true };

	if (NAMED.test(p)) return { tier: "tier_1", confidence: atMost(0.55), verification: "tests", matched: true };

	if (FIX.test(p)) return { tier: "tier_2", confidence: atMost(0.5), verification: "tests", matched: true };

	// Nothing matched: a guess, not a classification.
	return { tier: "tier_1", confidence: 0.45, verification: "tests", matched: false };
}
