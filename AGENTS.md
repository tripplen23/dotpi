# Global Pi instructions

## Git: never commit or push without permission

Do NOT run `git commit`, `git push`, `git add` + commit, or create/modify remote
repositories unless I explicitly ask for it in that turn (e.g. "commit", "push"). Making file changes is fine; staging/committing/pushing is not.

When work is ready, tell me what would be committed and wait for my go-ahead.

## Routing: triage before you act

When the `triage` tool is available (main session; subagents run without it), call it
with the user's request **verbatim** as the first action of any request that might need
work done — code changes, bug reports, investigations, reviews, UI checks, or design
questions. Do not paraphrase, summarise, or translate the request.

Follow the returned `Route:` line. If the result carries a low-confidence warning,
confirm the tier with the user via `ask_user_question` before spawning anything.

Skip triage for pure conversation that clearly needs no tools.

### Delegation thresholds

- About to grep and read **5+ files** just to orient? That is a `scout`, not a reading
  session. About to fetch **3+ web pages**? That is a `researcher`.
- Scout to find; read only the 1–3 files you actually edit.
- Before spawning `scout`, check whether this session already has a map for that area and
  reuse it. Re-scout only for a different area, a missed map, or a worker reporting wrong
  paths.

### Spawning

- Pick the agent with `agent`; `name` is a pane label only:
  `subagent({ agent: "scout", name: "auth-recon", task: "…" })`.
- At most **3** implementation panes at once; parallel workers own disjoint files.
- Only you spawn `reviewer`, and only when `Verification:` says `reviewer` or the tier is
  `tier_5_review`. `worker` and `planner` cannot.
- Never use `session-mode: fork` on an agent — it copies the whole conversation into the
  child.
- After spawning, say what you are waiting for and end the turn. Results arrive as steer
  messages; never poll, tail logs, or read session files to check status.

### Model overrides

`model:` on the spawn beats the agent's frontmatter, while `thinking`, `tools` and the
system prompt still come from the agent definition. So when I name a model or provider for
a role — "use Vertex Gemini for the planner, OpenRouter Haiku for the workers" — pass it
on that spawn; the role's default model is the wrong one for that run.

Resolve what I said to a full `provider/model` id with `pi --list-models <pattern>` before
spawning. Never guess an id from the nickname: a name that does not resolve kills the whole
spawn, and guessing `:thinking` on top of it fails the same way.

### Verification and repair

Apply `Verification:` once per wave, not once per pane. `tests` stops at the worker's own
check — do not upgrade it to a reviewer. `scout` = one scout re-reads the logic.
`browser` = one `qa` run. `reviewer` = one reviewer over the diff.

On `NEEDS CHANGES`: one repair `worker` whose whole task is the blocking finding, then a
fresh `reviewer`. Stop after **2 rounds**, on approval, or on a blocker. Never downgrade a
finding to force approval.

### Edit discipline

Never hand-retype `oldText`. Pull it verbatim from a prior `read`. If `edit` says the text
is not unique, widen the snippet with just enough context — do not retry the short one.
This was the single most expensive recoverable error class in a 1,245-session audit.

### Agent files

Never omit `tools:` from an agent definition: an empty allowlist passes no `--tools` flag
and the child inherits the **full unrestricted** toolset.
