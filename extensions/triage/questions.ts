/**
 * The triage question set.
 *
 * `is_ui_test` and `is_code_review` are separate `noul` questions rather than extra
 * choices on `task_tier`, so a keyword cannot steal the route: a bug report that
 * merely mentions clicking must not become a QA session, and "review the plan"
 * must not become a code review. Code composes the public tier from the three
 * answers (see index.ts).
 *
 * Criteria are deliberately RICH (what / not_for / examples). That is what makes
 * the trap cases land: measured on 2026-10-11, Jev scored 5/7 on the trap set with
 * flat criteria and 7/7 with these nested ones. Laya degrades with nested criteria,
 * which is one reason it is only the fallback.
 */

const FOCUS = [
	"If prior_request is set, treat `request` as a continuation of that work unless it clearly starts a new job.",
	"Short ship/proceed crumbs without a new feature are the same job, not a new one.",
	"Do not guess line counts, file counts, or repo layout.",
	"Tool launch, provider-key, and spawn-engine errors are configuration talk, not a project-file edit.",
	"'I have a bug' or 'an agent cannot click' is investigation of existing product code, not a QA session.",
].join(" ");

export const QUESTIONS = {
	is_code_review: {
		type: "noul",
		instructions: {
			question:
				"Is the primary deliverable of `request` a read-only assessment of existing code, with no plan to write and no implementation to do first?",
			focus: FOCUS,
		},
		criteria: {
			true: {
				what: "The user wants a code audit, project audit, security review, adversarial review, or a review of a PR or diff, and the deliverable is findings rather than a spec or a code change.",
				not_for:
					"Writing or approving a spec, a named fix, a bug hunt, a how-to, or driving a running UI. A code change is not automatically a code review.",
				examples: [
					"audit the auth module",
					"project audit",
					"security review of this diff",
					"review this PR",
					"adversarial review of src/billing",
				],
			},
			false: {
				what: "A plan or spec, a local fix, a bug investigation, an explanation, or a live UI session.",
				not_for: "A dedicated read-only code or project audit.",
				examples: [
					"review the plan",
					"create a plan for the billing rewrite",
					"fix the typo in src/auth.ts",
					"when I click submit nothing happens",
				],
			},
		},
	},
	is_ui_test: {
		type: "noul",
		instructions: {
			question:
				"Is the primary deliverable of `request` operating a running product UI, browser, or simulator to verify behavior?",
			focus: FOCUS,
		},
		criteria: {
			true: {
				what: "The user wants the agent to drive a running app — click through a product UI, use a browser against live software, or run a simulator — and report whether it works.",
				not_for:
					"Bug reports that mention clicking, asking where to click, production forensics, shipping or updating an app, implementing, or planning.",
				examples: [
					"click through the checkout flow and confirm payment succeeds",
					"test the login page in the browser",
					"take over my browser and do it yourself",
				],
			},
			false: {
				what: "A broken click, a how-to, a live incident, a ship/update, a code change, or a short 'check if it works' after work already in this thread.",
				not_for: "A dedicated QA/verification session against a running UI.",
				examples: [
					"when I click the agent link I get an empty list",
					"where do I click in the admin dashboard",
					"connect to production and check why the payment did not activate",
				],
			},
		},
	},
	task_tier: {
		type: "choice",
		instructions: {
			question: "Which execution route does `request` require?",
			focus: FOCUS,
		},
		criteria: {
			tier_0: {
				what: "Talk, explain, configure the tool (launch, keys, spawn engine), look up docs, status check of work already done, how-to/where-to-click, or a same-thread ship crumb. No project code changes.",
				not_for:
					"Any request to change project code, find files in the repo, design a system, investigate a live product bug, or audit existing code.",
				examples: [
					"what model are we using?",
					"the CLI doesn't launch, see why",
					"where do I click in the dashboard for the export check",
					"push commit and send to production",
					"ok",
				],
			},
			tier_1: {
				what: "A bounded project edit whose target is already named or obvious: one file, one function, a typo, or a specific error.",
				not_for: "Unknown location, production forensics, multi-area changes, new systems, a how-to, or a read-only code audit.",
				examples: ["fix the typo in src/auth.ts line 40", "rename getUser to fetchUser in api.ts", "the TypeError on line 88 of webhook.ts"],
			},
			tier_2: {
				what: "A bug or tweak to existing code whose files are NOT fully named: unnamed UI copy, a broken click, an agent report, or a production forensic (named customer, live incident, admin not loading).",
				not_for: "A named local fix, a new subsystem or architecture, a how-to with no code change, or a read-only audit.",
				examples: [
					"when I click the agent link I get an empty list",
					"one of my agents can't upload the file, make sure it's fixed",
					"the admin is not loading, it's slow to login",
					"a customer uploaded a document but it's not showing, investigate",
				],
			},
			tier_3: {
				what: "A new subsystem, architectural refactor, new page/surface, or an explicit ask to write a plan or spec before implementation.",
				not_for:
					"A tweak or bugfix to an existing flow (including research-then-fix on messaging, queue, or copy), a named local fix, a how-to, or a read-only audit of code that already exists.",
				examples: [
					"build a page for customers to order a custom report",
					"create a plan for these improvements",
					"plan a fix for these issues, make our system faster",
					"review the plan",
					"redesign the admin landing page",
				],
			},
		},
	},
	verification: {
		type: "choice",
		instructions: {
			question: "After the code change, which extra check does `request` need beyond the tests a worker already runs?",
			focus:
				"Workers run tests without being asked. Do not pick reviewer because code will change. Pick reviewer only for security, billing, migration, data loss, or an explicit review of the change. Pick browser when proof is operating a running UI. Pick scout when proof is re-reading core logic. Otherwise tests.",
		},
		criteria: {
			tests: {
				what: "The worker's own runnable check is the verification. No extra agent.",
				not_for: "A UI that must be operated, a logic re-read, or a security/billing/migration review.",
				examples: ["fix the typo in src/auth.ts line 40", "rename getUser to fetchUser in api.ts"],
			},
			scout: {
				what: "Someone must re-read the changed logic and say whether it matches the brief. Not a line-by-line code review.",
				not_for: "A typo, a running UI, or a security review.",
				examples: ["make sure the retry calculation is right", "double-check the core logic of the discount math"],
			},
			browser: {
				what: "The proof is operating a running page, button, or screen after the change.",
				not_for: "A logic-only fix, a typo, or a read-only audit.",
				examples: ["when I click submit nothing happens", "the login button is broken"],
			},
			reviewer: {
				what: "The change can lose data, break a payment or auth boundary, migrate stored state, or the user asked for a review of the diff.",
				not_for: "Ordinary fixes, UI checks, or logic re-reads. Tests and a scout cover those.",
				examples: ["fix the payment retry so we cannot double charge", "review this change for data loss"],
			},
		},
	},
} as const;

/** Same numbers ultimate-pi uses. */
export const UI_TEST_NOUL_THRESHOLD = 0.75;
export const UI_TEST_CONFIDENCE_THRESHOLD = 0.7;

/** Below these floors the orchestrator must confirm with the user before routing. */
export function minConfidenceFor(tier: string): number {
	if (tier === "tier_3" || tier === "tier_4_qa" || tier === "tier_5_review") return 70;
	return 50;
}
