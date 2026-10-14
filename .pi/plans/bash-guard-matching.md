# bash-guard: replace substring matching with token-aware unit analysis

## Goal

The bash-guard extension blocks or prompts on dangerous bash commands. Its interactive
main-session path already parses with `shell-quote`, but its two hard-block "floor" paths
(subagent mode and disabled mode) match raw regexes against the whole command string, so
`echo 'rm -rf /'`, `echo 'git push'`, and guard self-tests get blocked although nothing
destructive executes. This was observed live this session: a subagent test command whose
text merely contained `rm -rf /` inside a string literal was refused.

The change replaces the floor's regex matching — and the interactive path's remaining
raw-text heuristics (redirection, newline handling, `$(...)`/backtick blind spots) — with
one shared, token-aware analyzer: a quote-aware raw scanner plus `shell-quote` tokenization
that extracts the *executable units* of a command (top-level commands, pipeline stages,
`sh -c "…"`/`eval` wrappers, `$()`/backtick substitutions, and heredocs fed to a shell
interpreter), then matches pattern predicates against those units. Quoted strings, grep
patterns, commit messages, comments, and heredoc bodies that merely *contain* a blocked
phrase must pass; every real destructive position must still block. Done means: the
acceptance matrix in `Verification` passes, and `--bash-guard-disabled` still allows
routine git.

## Files

- `extensions/bash-guard/analyze.ts` — **new**. Pure core: raw scanner, tokenizer, unit
  extraction, pattern tables, `analyzeCommand()`. No pi SDK imports (only `shell-quote`)
  so it is testable with plain `node`.
- `extensions/bash-guard/index.ts` — **edit**. Delete `analyzeSegment`, `analyzeBashCommand`,
  `splitOnOps`, `hasFlag`, `anyArgStartsWith`, `tokensToStrings`, `isOpToken`/`Token` types,
  `hasDestructiveRedirect`, `HEADLESS_BLOCKED`, `MAIN_DISABLED_BLOCKED`; import
  `analyzeCommand` from `./analyze.ts` and drive all three `tool_call` branches from it.
  UI, flags, `/bash-guard` toggle, badge, `recentlyAborted`, "always allow" flow stay as-is.
- `extensions/bash-guard/analyze.test.ts` — **new**. Table-driven acceptance matrix run by
  plain `node` (Node 26 strips erasable TS; verified `shell-quote` resolves from the
  extension's own `node_modules`). Not loaded by pi: `package.json` `pi.extensions` lists
  only `./index.ts`.
- `extensions/bash-guard/package.json` — **edit** (minor): add
  `"scripts": { "test": "node analyze.test.ts" }`.
- `extensions/bash-guard/README.md` — **edit**: document the matching model, the fixed
  false-positive classes, recursion cases, and the residual limits listed in Risks.

Multi-file extensions are supported per
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
("Use a single file for a small extension and a directory for a multi-file implementation").

## Steps

1. Create `extensions/bash-guard/analyze.ts` (see Interfaces for the exported surface, and
   the algorithm details below). Steps 1a–1e build it in order; all internal, not exported
   except where noted.

   **1a. Raw scanner (single pass over the command string).** Walk characters left to
   right, tracking region state, and produce: (a) newline normalization for the string that
   will be tokenized, (b) a list of *substitution spans* and *heredoc bodies* to analyze
   recursively.
   - Single-quoted `'…'` region: everything literal; substitutions inside are data. Skip
     to closing `'`.
   - Double-quoted `"…"` region: substitutions ARE executable. On `\`, skip the next char
     (so `\$(` stays literal). Record any `$(…)` span (with nesting depth counting) and any
     `` `…` `` span found here.
   - Unquoted region: same substitution recording; on `\`, skip next char.
   - Comment region: `#` outside quotes runs to end of line; skip its contents.
   - Heredoc region: on `<<` or `<<-` outside quotes, read the tag (`<<'TAG'`, `<<"TAG"`,
     `<<TAG` forms), then record the body (lines up to a line equal to the tag) *with its
     line span*, and do not newline-normalize inside the body.
   - Newline normalization for tokenization: a newline outside quotes/comments/heredoc
     bodies becomes `;`. A `\` immediately before such a newline is removed (line
     continuation). This is semantically equivalent and lets `shell-quote` see command
     separators it otherwise ignores (verified: `parse("true\nrm -rf /")` yields one
     undifferentiated segment today — a live false-negative hole).
   - Recursion depth cap: 8. At the cap, stop recursing and set `parseFailed = true`
     (which triggers the fallback in 1e).

   **1b. Tokenize.** Run `shell-quote`'s `parse` (imported as today in index.ts) on the
   newline-normalized string. Verified token grammar of shell-quote 1.8.3 (from
   `node_modules/shell-quote/parse.js` and live runs): strings; op tokens for `&&`, `||`,
   `;;`, `|&`, `<<-`→ no (becomes two `<`), `>>`, `>&`, `<&`, `<(`, `<<<`, and single
   `& ; ( ) | < >`; `{op:'glob',pattern}`; `{comment:…}`; `{op:'('}`/`{op:')'}` for unquoted
   `$(…)` and subshells. Parse throws only on bad `${…}` substitution — catch it and set
   `parseFailed = true`.

   **1c. Build units.** Split the token stream into segments on ops `;`, `&`, `&&`, `||`,
   `|`, `|&` (this makes each pipeline stage its own unit — today `|` does not split).
   Per segment, build `argv` from string tokens with these rules:
   - Drop `{comment}` objects and `{op:'glob'}` objects (but track "had glob" per segment).
   - Drop a pure-digit string token that immediately precedes a `>`/`>>`/`>&`/`>>&`/`<`
     op (fd number, e.g. the `2` in `2>&1`), and a pure-digit token immediately following
     `>&`/`>>&`.
   - Strip leading shell keywords `if then elif else do done fi !`, then strip leading
     non-executing prefixes `{exec, env, nohup, nice, time, command, xargs}`, skipping any
     `-`-prefixed flag args that follow those prefixes (so `env -i git push` and
     `xargs -0 rm -rf` resolve to their real command).
   - Stop flag-scanning at a bare `--` argument.
   - Basename-normalize `argv[0]` (`/bin/rm` → `rm`).
   Mark the unit's provenance: `top`, or `subst`/`wrapper`/`heredoc` for recursive ones.

   Recursive unit extraction — each of these feeds the extracted text/string back through
   the whole unit builder (1a–1c):
   - Substitution spans from 1a (provenance `subst`).
   - Wrapper `sh -c "…"`: if the resolved cmd is one of `sh bash zsh dash ksh` and a `-c`
     flag is present, recursively analyze the first non-flag argument after `-c`
     (provenance `wrapper`). Handles arbitrary nesting (`sh -c "sh -c '…'"`).
   - `eval`: cmd `eval` → recursively analyze the remaining args joined with spaces.
   - Shell-stdin heredoc: if the resolved cmd is one of `sh bash zsh dash ksh` and the
     segment contained a heredoc (1a recorded it), recursively analyze the body lines
     (provenance `heredoc`). Bodies of *other* commands (`cat <<EOF`, `git commit -F -`)
     are data — never analyzed as commands.
   - `find -exec`/`-execdir`: for cmd `find`, if args contain `-exec`/`-execdir`, analyze
     the arg slice after it up to the first of `;` `+` `{} +` as a unit.

   **1d. Pattern tables.** One table of unit predicates replaces both regex lists. Shape:

   ```ts
   type UnitCheck = {
     id: string;
     match: (argv: string[], hadGlob: boolean) => boolean;
     reason: string;
     severity: "high" | "medium";
     floor: boolean;          // headless (subagent) hard-block
     disabledFloor: boolean;  // hard-block when --bash-guard-disabled / "always allow"
   };
   ```

   Flag detection helper: an arg matches "contains flag letter X" iff
   `/^-[a-zA-Z]+$/` and the letters include X (case-insensitive for r/R), or the arg is
   the long form (`--recursive`, `--force`, `--in-place`). Scanning stops at `--`.

   Floor patterns (all `severity: "high"`; `floor: true` unless noted):

   | id | predicate | disabledFloor |
   |---|---|---|
   | rm-recursive | cmd `rm`/`rmdir`/`unlink` with `-r`/`-R` cluster or `--recursive` | true |
   | sudo | cmd `sudo` (after prefix-strip; stays cmd because `sudo` is *not* stripped) | true |
   | pipe-to-shell | cmd `sh`/`bash`/`zsh`/`dash`/`ksh` in a non-first pipeline stage AND some earlier stage's cmd is `curl`/`wget` | true |
   | mkfs | cmd starts with `mkfs` | true |
   | newfs | cmd starts with `newfs_` | true |
   | wipefs | cmd `wipefs` | true |
   | diskutil-destructive | cmd `diskutil` and sub ∈ {eraseDisk, eraseVolume, zeroDisk, secureErase, reformat} | true |
   | dd-device | cmd `dd` and some arg starts with `of=/dev/` | true |
   | partition | cmd ∈ {parted, fdisk, gdisk, sgdisk} | true |
   | cryptsetup | cmd `cryptsetup` | true |
   | zpool | cmd `zpool` | true |
   | poweroff | cmd ∈ {shutdown, reboot, halt, poweroff} | true |
   | terraform-destroy | cmd `terraform`, sub `destroy` | true |
   | kubectl-delete | cmd `kubectl`, sub `delete` | true |
   | aws-s3-rm-recursive | cmd `aws`, sub `s3`, arg `rm`, `--recursive` present | true |
   | git-commit | cmd `git`, sub `commit` | **false** |
   | git-pull | cmd `git`, sub `pull` | **false** |
   | git-push | cmd `git`, sub `push`, no force flag | **false** |
   | git-push-force | cmd `git`, sub `push`, force flag (`--force`, `--force-with-lease`, `-f` cluster containing f) | true |
   | git-reset-hard | cmd `git`, sub `reset`, `--hard` present | true |
   | git-clean-force | cmd `git`, sub `clean`, flag letter `f` present (covers `-fd`, `-fdx`) | true |
   | git-reflog-expire | cmd `git`, sub `reflog`, sub2 `expire` | true |
   | git-gc-prune | cmd `git`, sub `gc`, any arg starts with `--prune` | true |

   `git` sub detection must skip git global flags before the subcommand: the first
   non-flag arg, except that `-c` consumes itself plus the next arg (so `git -C /repo push`
   and `git -c x=y push` resolve sub `push` — today's regex caught these on raw text).

   Interactive-only checks (drive the main-session prompt; `floor`/`disabledFloor` false),
   ported from today's `analyzeSegment` semantics unchanged:
   - any `git` command → medium ("git <sub>"), with the existing high escalations already
     covered by the floor rows above (`git rm`, `git clean -f…`, `git reset --hard`,
     `git push --force`, `git reflog expire`, `git gc --prune`) plus `git checkout/restore`
     with `.`/`--`/`--source` → medium.
   - any `rm`/`rmdir`/`unlink` → high (+ `-f` and glob notes; `mkfs`-style prefix rows stay
     independent).
   - `find` with `-delete` → high; `find` with `-exec` recursion handled in 1c.
   - `truncate` → medium; `dd` with any `of=` → high; `diskutil` (any sub) → medium,
     `hdiutil` → medium, `gpt` → high, `asr` → high, `lsblk` → medium.
   - `chmod -R` / `chown -R` → medium; `mv -f` / `cp -f` → medium.
   - `sed` with `-i`/`--in-place` → medium; `perl` with `-pi`/`-p`+`-i` → medium.
   - `kill`/`pkill`/`killall` → medium, `-9` → high; `systemctl stop|disable` → medium;
     `gcloud` with `delete` → high (interactive-only, as today).
   - any pipe into a shell (non-first stage cmd ∈ shells, regardless of source) → high.
   - Redirect check (replaces `hasDestructiveRedirect` regex, token-level): an op `>` or
     `>>` whose following string token exists and is not `/dev/null` → medium
     ("shell output redirection"). Ops `>&`, `>>&`, `<`, `<<<`, `<(` are never flagged —
     which fixes `grep "a > b" f.txt` (quoted `>` produces no op token; verified).

   **1e. Fallback on parse failure (fail-closed, bounded).** Keep the current
   `HEADLESS_BLOCKED` regex list, renamed `LEGACY_FALLBACK`, used *only* when
   `parseFailed` is true (scanner depth cap, or shell-quote throw). In that case:
   interactive path → return a medium Risk "could not fully analyze this command" (same
   fail-closed-to-prompt behavior as today's throw handler); floors → test the extracted
   units against the normal tables **and** the raw command against `LEGACY_FALLBACK`
   (fail-closed). Rationale: interactively a prompt costs one keypress, so bias to
   prompt; in headless mode the costly error is silent execution, so bias to block; the
   legacy-regex false positives that motivated this fix only reappear for inputs the
   parser could not structure at all, which is rare — the observed FPs (`echo 'rm -rf /'`,
   quoted `git push`, heredoc data) all parse fine and go through unit checks.

2. Wire `analyzeCommand` into `extensions/bash-guard/index.ts`:
   - Subagent branch: block iff `analysis.floorRisk` (message text unchanged).
   - Disabled branch (flag `/bash-guard` or `--bash-guard-disabled`): block iff
     `analysis.disabledFloorRisk`. This preserves the convention that routine git
     (`commit`/`pull`/plain `push`) passes when disabled — those predicates have
     `disabledFloor: false`.
   - Interactive branch: prompt iff `analysis.interactiveRisk`. Everything downstream
     (`recentlyAborted`, `--bash-guard-auto-allow`, Run/Always/Abort dialog) untouched.
   - Note `MAIN_DISABLED_BLOCKED`'s fragile filter-by-regex-source-string goes away; the
     disabled floor is just the `disabledFloor` column.

3. Create `extensions/bash-guard/analyze.test.ts`: plain script, no test framework —
   iterate an expectations table, `console.log` one line per case, `process.exitCode = 1`
   on any mismatch. Table contents are exactly the acceptance matrix below.

4. Update `extensions/bash-guard/README.md`: describe token-aware unit matching; add the
   fixed FP classes (string literals, comments, heredoc data bodies, quoted redirects) and
   the newly covered recursion cases (`sh -c`, `eval`, `$()`/backticks, shell-stdin
   heredocs, `find -exec`, `xargs`, newline-separated commands); document fail-closed
   fallback and the residual limits from Risks; add the dev test command.

## Interfaces

```ts
// extensions/bash-guard/analyze.ts — the only cross-file boundary
export type Severity = "high" | "medium";
export type Risk = { severity: Severity; reasons: string[] };
export type Unit = { argv: string[]; provenance: "top" | "subst" | "wrapper" | "heredoc" };
export type Analysis = {
  parseFailed: boolean;
  interactiveRisk: Risk | null;   // main-session prompt level
  floorRisk: Risk | null;         // subagent hard-block floor
  disabledFloorRisk: Risk | null; // --bash-guard-disabled / "always allow" floor
};
export function analyzeCommand(command: string): Analysis;
```

`index.ts` keeps its existing public surface unchanged: same `pi.on("tool_call")` block
result shape, same flags `--bash-guard-auto-allow` / `--bash-guard-disabled`, same
`/bash-guard` command, same status-key badge. Only the decision function is swapped.
`analyze.ts` must use only erasable TypeScript (no enums, no parameter properties) so both
pi's extension loader and `node`'s type stripping accept it.

## Risks

- shell-quote 1.8.3 quirks I verified by reading `parse.js` and live runs, but exotic
  inputs (`$'…'` ANSI-C quoting, `[[ … =~ … ]]`, unmatched braces) may still mis-parse.
  Mitigated: those hit `parseFailed` → fail-closed fallback (1e).
- The newline→`;` preprocessing (1a) changes multi-line commands globally. If the scanner
  mis-classifies a region, a multi-line quoted string could be split. The acceptance
  matrix includes a multi-line quoted case and a heredoc case to pin this down.
- Behavior changes that are intentional and must not surprise: `true\nrm -rf /tmp/x`
  (newline-separated) now blocks in floors — previously passed silently;
  `... | xargs rm -rf` now blocks — previously only the interactive path saw `xargs` as
  cmd and passed. Both close real false negatives.
- Unchanged by design, noted so a reviewer doesn't "fix" it: `git log --grep="git push"`
  still *prompts* in the main session because any `git` command prompts there; the fix
  targets the floors, not the any-git interactive rule.
- Depth-8 recursion cap: a hand-crafted 9-deep nested wrapper escapes unit analysis and
  falls to the legacy regex, which still catches flat patterns inside it.
- Residual, documented-not-fixed: heredocs fed to non-shell interpreters
  (`python - <<EOF`, `node <<EOF`, `perl <<EOF`) are treated as data; their bodies could
  contain destructive shell-outs. Modeling every scripting language is out of scope for a
  safety net that sits under agent discipline (per this session's convention).

## Verification

Automated — the exact command (run from the extension dir, no new dependencies):

```
cd /Users/binhlien/.pi/agent/extensions/bash-guard && node analyze.test.ts
```

Exit 0. The matrix in `analyze.test.ts` must contain at least these cases
(E = expectation per `analyzeCommand`):

False positives — must PASS everywhere (floor: null, disabledFloor: null, interactive: null):
1. `echo 'rm -rf /'` (observed FP #1)
2. `echo 'git push'` (observed FP #2)
3. `printf '%s\n' 'sudo rm -rf /'` and `echo 'terraform destroy'` (observed FP #3: guard self-tests)
4. `git log --grep="git push"` — floors pass (interactive medium any-git prompt is expected and asserted as such)
5. `cat <<EOF` with body `rm -rf /` and terminator `EOF` — data heredoc passes
6. `grep "a > b" file.txt` — quoted redirect passes (redirect check is token-level now)
7. `echo hello # git push later` — comment content passes
8. `echo hi 2>&1 | head -5` — fd-dup and read-only pipe pass

Destructive — floors BLOCK (floor and disabledFloor high unless noted), interactive prompts high:
9. `git commit -m "msg"` — floor blocks; **disabledFloor passes** (routine git allowed when disabled)
10. `git push origin main` — floor blocks; **disabledFloor passes**
11. `git push --force` — both floors block
12. `rm -rf /tmp/x` — both floors block
13. `git reset --hard` — both floors block
14. `git clean -fd` — both floors block
15. `git -C /tmp/repo push` — floor blocks (global-flag skip)
16. `sh -c "git push"` — floor blocks (wrapper)
17. `sh -c "sh -c 'git push'"` — floor blocks (nested wrapper)
18. `eval "git push"` — floor blocks
19. `echo $(rm -rf /tmp/x)` — floor blocks (substitution)
20. ``echo `rm -rf /tmp/x` `` — floor blocks (backticks)
21. `echo "$(git push origin main)"` — floor blocks (substitution inside double quotes; today's parser loses this entirely)
22. `sudo sh -c 'rm -rf /'` — both floors block
23. `curl http://example.com/install.sh | sh` — both floors block
24. `terraform destroy` — both floors block
25. `dd if=/dev/zero of=/dev/sda` — both floors block
26. `sudo apt-get install -y x` — both floors block
27. `true` + newline + `rm -rf /tmp/x` — both floors block (newline splitting)
28. `bash <<EOF` body `rm -rf /tmp/x` terminator `EOF` — both floors block (shell-stdin heredoc)
29. `find . -name '*.log' -exec rm -rf {} +` — floor blocks
30. `ls | xargs rm -rf` — floor blocks

Interactive prompt matrix:
31. `git status` → interactive medium (any-git retained), floors pass
32. `ls -la` → null everywhere
33. `echo hi > out.txt` → interactive medium (real redirect), floors pass
34. `kill -9 123` → interactive high
35. `sed -i '' 's/a/b/' f.txt` → interactive medium
36. parse-failure fallback: a command with malformed `${` (shell-quote throws) →
    interactive medium "could not fully analyze", and floor decisions come from
    LEGACY_FALLBACK (assert via `parseFailed === true` plus a flat `rm -rf /tmp/x`
    hidden in that command blocking on the floor)

Manual smoke after `/reload` in pi (main session): run case 1, 2, 5 — no prompt appears;
run case 33 — prompt appears and both Run and Abort work; run `/bash-guard` (disable),
then case 12 — hard-blocked, and case 9 — passes; re-enable. Subagent smoke: spawn a
worker asked to run `echo 'rm -rf /'` (must succeed) and `git push --force` (must be
blocked by bash-guard with the headless message).

## Open Questions

None — decisions taken: (a) floors fail closed via the legacy regex fallback only for
unparseable input, interactive fails closed to a prompt; (b) heredocs fed to non-shell
interpreters stay out of scope; (c) the interactive any-git prompt rule is unchanged.