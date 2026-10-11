# dotpi

<p align="center">
  <img src="assets/hero.png" alt="dotpi — global Pi configuration" width="100%">
</p>

Global [Pi](https://pi.dev) configuration, cloned straight into `~/.pi/agent`.

## What is personal / ignored

Secrets and machine state are in `.gitignore`: `auth.json`, `mcp-auth.json`,
`env.sh`, `trust.json`, `sessions/`, `models-store.json`, installed packages
(`git/`, `npm/`, `bin/`), and `node_modules`.

## Fresh machine setup

```bash
# 1. Clone into place (repo path == config path)
#    --recurse-submodules also fetches extensions/pi-swarm and extensions/pi-talk
#    (their own repos: tripplen23/pi-swarm, tripplen23/pi-talk)
git clone --recurse-submodules git@github.com:tripplen23/dotpi.git ~/.pi/agent

#    Already cloned without the flag? Fetch the submodule:
#    git -C ~/.pi/agent submodule update --init --recursive

# 2. Secrets: copy the template and fill in your keys
cp ~/.pi/agent/env.example.sh ~/.pi/agent/env.sh
$EDITOR ~/.pi/agent/env.sh

# 3. Source env.sh from your shell rc (zsh OR bash — the file is plain sh)
#    ~/.zshrc  or  ~/.bashrc:
[ -f ~/.pi/agent/env.sh ] && . ~/.pi/agent/env.sh

# 4. Install the packages listed in settings.json (Caveman, Ponytail) and the
#    browser extension deps
pi update --extensions
cd ~/.pi/agent/extensions/browser && npm install && npx playwright install chromium

# 5. Editor/type-check deps (optional; removes TS errors in VSCode)
npm install --prefix ~/.pi/agent
cd ~/.pi/agent/extensions/pi-swarm && npm install
cd ~/.pi/agent/extensions/pi-talk && npm install

# 6. Voice dictation (extensions/pi-talk) needs sox + a key
brew install sox                  # provides `rec`
# then set ELEVENLABS_API_KEY in env.sh (see env.example.sh)
```

## Layout

| Path | What |
|------|------|
| `settings.json` | default provider/model, `packages` list |
| `mcp.json` | MCP servers (playwright chrome/webkit, firecrawl, exa). Keys come from `$FIRECRAWL_API_KEY` / `$EXA_API_KEY` |
| `extensions/` | `web-search-fallback.ts` (Exa → Firecrawl → Playwright), `browser/`, `bash-guard/`, `web-fetch/`, `ask-user-question.ts`, `prompt-snippets/`, `plan-mode/` |
| `extensions/pi-swarm/` | **git submodule** — async interactive subagents in Herdr panes |
| `extensions/pi-talk/` | **git submodule** — voice dictation, needs `sox` + `$ELEVENLABS_API_KEY` |
| `env.sh` | secrets, **not committed**; template in `env.example.sh` |

## Skills

Pi reads skills from **`~/.agents/skills/`** (shared across Pi, OpenCode,
Claude Code, and 70+ agents via the [`skills`](https://github.com/vercel-labs/skills)
CLI) plus the git packages in `settings.json` (Caveman, Ponytail).

`~/.agents/` is **not** in this repo. Reproduce it on a new machine with:

```bash
npx skills add mattpocock/skills    --skill '*' -g -a pi -a opencode -a claude-code -y
npx skills add cloudflare/skills    --skill '*' -g -a pi -a opencode -a claude-code -y
npx skills add google/skills        --skill '*' -g -a pi -a opencode -a claude-code -y
npx skills update -g -y   # later updates
```

`~/.agents/.skill-lock.json` records installed sources; the CLI symlinks each
skill into `~/.claude/skills/` (OpenCode and Pi read `~/.agents/skills/` directly).
