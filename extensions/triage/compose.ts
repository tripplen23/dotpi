/**
 * Folding engine answers into one routing tier.
 *
 * Kept free of any pi import so it can be exercised directly by a harness against
 * the live engines (see the triage benchmark in /tmp), rather than only in-process.
 */
import { UI_TEST_CONFIDENCE_THRESHOLD, UI_TEST_NOUL_THRESHOLD } from "./questions.ts";
import type { Verification } from "./fallback.ts";

export type Answers = Record<
	string,
	{ choice?: string; noul?: number; confidence?: number; answer_confidence?: number }
>;

/**
 * Fold the two `noul`s and the `choice` into one public tier.
 *
 * UI wins over review when both fire, because the reviewer has no browser tools.
 * `answer_confidence` is read before `confidence`: Laya emits both (they differ —
 * P(answer) vs 1 - normalised entropy) while Jev emits only `confidence`, where it
 * already means P(answer).
 *
 * A missing noul confidence counts as confident. Jev omits it on noul answers, so
 * requiring it would silently drop every QA and review route.
 */
export function compose(answers: Answers): { tier: string; confidence?: number } {
	const noul = (n: string) => answers?.[n]?.noul ?? 0;
	const conf = (n: string) => answers?.[n]?.answer_confidence ?? answers?.[n]?.confidence;
	const confident = (n: string) => conf(n) === undefined || conf(n)! >= UI_TEST_CONFIDENCE_THRESHOLD;

	if (noul("is_ui_test") >= UI_TEST_NOUL_THRESHOLD && confident("is_ui_test")) {
		return { tier: "tier_4_qa", confidence: conf("is_ui_test") };
	}
	if (noul("is_code_review") >= UI_TEST_NOUL_THRESHOLD && confident("is_code_review")) {
		return { tier: "tier_5_review", confidence: conf("is_code_review") };
	}
	return { tier: answers?.task_tier?.choice ?? "unknown", confidence: conf("task_tier") };
}

/** Which extra check the request needs. Tiers with an obvious check pin it. */
export function verificationOf(answers: Answers, tier: string): Verification {
	if (tier === "tier_4_qa") return "browser";
	if (tier === "tier_5_review") return "reviewer";
	const v = answers?.verification?.choice;
	return v === "scout" || v === "browser" || v === "reviewer" ? v : "tests";
}
