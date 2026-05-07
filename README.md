# claude/codex-save-to-obsidian

A tiny [Claude Code](https://claude.com/claude-code) **Stop hook** that archives every conversation to your Obsidian vault as a clean, incrementally-updated Markdown note.

It also includes a companion Codex Desktop/CLI archiver. The Codex version is installed through a small `notify` wrapper that triggers the Obsidian save in the background and then forwards to Codex Desktop's Computer Use notification hook when present.

> One file per session. Re-opened sessions keep growing the same note. Titles are derived from your first prompt, and `thinking` / `tool_use` / `tool_result` blocks are rendered as collapsible Obsidian callouts so the log stays skimmable.

## Why

Claude Code keeps your transcripts in `~/.claude/projects/<slug>/<session_id>.jsonl`, which is great for the tool but terrible for human reading and Obsidian linking. This script turns each session into a single Markdown file that lives in your vault, searchable and backlinkable like any other note.

## What the output looks like

Filename: `2026-04-21_<your-opening-prompt-slug>__<session_id>.md`

```markdown
---
date: 2026-04-21
updated: 2026-04-21
type: claude-log
tags: [AI/Claude]
cwd: "/path/to/your/project"
session_id: 00000000-0000-0000-0000-000000000000
---

# <your-opening-prompt-slug>

### 😏 User _(2026-04-21T06:32:36.785Z)_

your first question to claude…

---

### 🤖 Claude _(2026-04-21T06:32:41.715Z)_

> [!note]- thinking
> collapsed reasoning block…

**🛠 Read** `{"file_path":"..."}`

> [!example]- tool_result
> collapsed tool output (800-char cap)…

the actual answer text.

---
```

## Install: Claude Code

### 1. Get the script somewhere stable

```bash
git clone https://github.com/<you>/save_to_obsidian.git ~/.ai-save-to-obsidian
```

Any path works — `~/.agent/`, `~/bin/`, wherever you keep scripts. The Claude hook just needs to know where to find `obsidian-save.js`.

### 2. Point it at your vault

Set `CLAUDE_OBSIDIAN_VAULT` when invoking the hook. The script also accepts `~` in the path. If nothing is set, it defaults to `~/ClaudeHistory`.

### 3. Register a Stop hook in Claude Code

Edit `~/.claude/settings.json` (user-level, applies to every project):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "CLAUDE_OBSIDIAN_VAULT=~/Obsidian/Vault/Claude_History node ~/.ai-save-to-obsidian/obsidian-save.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Swap `CLAUDE_OBSIDIAN_VAULT` and the script path for your own locations.

> ⚠️  Hook shape matters. Claude Code expects each entry under `Stop` to be `{ "hooks": [ ... ] }` — **not** a flat `{ type, command }` object. A malformed `settings.json` silently disables *all* settings from that file.

### 4. Verify

Start a new Claude Code session, say one thing, end it. A file should appear in the vault:

```bash
ls -lt ~/Obsidian/Vault/Claude_History | head
```

If nothing shows up, check `$TMPDIR/claude-save-error.log` — the script catches every error there.

## Install: Codex Desktop/CLI

Codex stores sessions under `~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl` and keeps a session index at `~/.codex/session_index.jsonl`. The Codex archiver reads those files directly and writes one Markdown note per session.

> The wrapper exists because Codex Desktop plugins can also use `notify`. It runs the saver asynchronously, then forwards to the bundled Computer Use notification client when it can find one. If you already have a custom `notify` command, set `CODEX_NOTIFY_FORWARD` or edit the wrapper so your existing command still runs.

### 1. Put the script somewhere stable

```bash
git clone https://github.com/<you>/save_to_obsidian.git ~/.ai-save-to-obsidian
```

The Codex script is `codex-obsidian-save.js`.

### 2. Point it at your vault

Set `CODEX_OBSIDIAN_VAULT` when invoking the script. If nothing is set, it defaults to `~/CodexHistory`.

For a manual smoke test:

```bash
CODEX_OBSIDIAN_VAULT=~/Obsidian/Vault/CodexHistory node ~/.ai-save-to-obsidian/codex-obsidian-save.js --background-save
```

### 3. Install the notify wrapper

Make the wrapper executable:

```bash
chmod +x ~/.ai-save-to-obsidian/codex-notify-wrapper.sh
```

Then update `~/.codex/config.toml`:

```toml
notify = ["/path/to/.ai-save-to-obsidian/codex-notify-wrapper.sh"]
```

If you want a custom vault path or Codex home, set environment variables before launching Codex:

```bash
export CODEX_OBSIDIAN_VAULT=~/Obsidian/Vault/CodexHistory
export CODEX_HOME=~/.codex
```

If you already had a custom `notify` command and want the wrapper to forward to it, set `CODEX_NOTIFY_FORWARD` to the command string:

```bash
export CODEX_NOTIFY_FORWARD="/path/to/existing-notify-command arg1 arg2"
```

The wrapper automatically forwards to Codex Desktop's bundled Computer Use notifier when installed under the standard Codex plugin cache. Script-level errors go to `$TMPDIR/codex-save-error.log`, and debug messages go to `$TMPDIR/codex-obsidian-save-debug.log`.

### 4. Verify

Start a Codex session, send a short message, and wait a few seconds after the response finishes. A file should appear or update in your Codex history folder:

```bash
ls -lt ~/Obsidian/Vault/CodexHistory | head
```

## How it works

### Claude Code

**The Stop-hook payload does not contain the transcript inline.** Claude Code only sends:

```json
{
  "session_id": "00000000-0000-0000-0000-000000000000",
  "transcript_path": "/Users/you/.claude/projects/<slug>/<session_id>.jsonl",
  "cwd": "…",
  "last_assistant_message": "…"
}
```

The real conversation lives at `transcript_path` as JSONL, one event per line. The script:

1. Reads that JSONL
2. Keeps only `type: "user"` / `"assistant"` lines (skips `isSidechain: true` subagent traffic, queue-operation events, hook events, etc.)
3. Renders each message's `content` array:
   - `text` → as-is
   - `thinking` → collapsed `> [!note]-` callout
   - `tool_use` → one-line `**🛠 <name>** <input preview>` (400-char cap on input)
   - `tool_result` → collapsed `> [!example]-` callout (800-char cap)
4. Scans the vault for an existing `*__<session_id>.md` file
   - If found → overwrite in place (incremental update; the JSONL is cumulative so the rewrite naturally includes new turns)
   - If not → create `<start-date>_<slug>__<session_id>.md`
5. Writes frontmatter with `date` (start), `updated` (now), `cwd`, `session_id`, and a `# <slug>` heading

### Codex

Codex session files are JSONL rollouts. The script:

1. Scans `CODEX_HOME` (defaults to `~/.codex`) for `sessions/**/rollout-*.jsonl` and `archived_sessions/*.jsonl`
2. Deduplicates by session id and chooses the newest copy
3. Reads `session_index.jsonl` to use Codex's thread title when available
4. Keeps `response_item.payload.type === "message"` entries with `role: "user"` or `"assistant"`
5. Skips synthetic environment/skill payloads so the note is mostly human conversation
6. Rewrites the existing `*__<session_id>.md` note if present, or creates a new note otherwise

The Codex script also accepts:

```bash
node codex-obsidian-save.js --background-save
node codex-obsidian-save.js --file /path/to/rollout.jsonl
node codex-obsidian-save.js --session <session-id>
node codex-obsidian-save.js --all
node codex-obsidian-save.js --all --days 7
```

### About the title

Claude Code's auto-generated session title (shown in the tab / topic bar) is computed **server-side** and is not persisted anywhere in `~/.claude/` that a hook can read. This script therefore derives a slug from your first user prompt:

- strips `@/path` mentions and `/slash-commands`
- takes the first sentence-ish chunk
- removes filesystem-hostile chars
- caps at 50 chars

Good enough to skim the vault. If you want a prettier name, rename the file in Obsidian — as long as you **keep the `__<session_id>.md` suffix**, the next Stop will keep updating your renamed file instead of creating a sibling.

## Customizing

Everything worth tweaking is in one file. Open `obsidian-save.js` and adjust:

| What | Where | How |
|---|---|---|
| Vault path | top of file | `CLAUDE_OBSIDIAN_VAULT` env var, or edit `RAW_PATH` default |
| Role emojis | `saveToObsidian` → `heading` | change the `😏` / `🤖` to whatever you like |
| Tool-input cap | `renderContent` `tool_use` branch | `400` |
| Tool-output cap | `renderContent` `tool_result` branch | `800` |
| Skip short sessions | inside `process.stdin.on('end', ...)` | add `if (turns.length < N) return;` |
| Include subagent traffic | `readTranscript` | remove the `if (entry.isSidechain) continue;` guard (makes files much larger) |

For `codex-obsidian-save.js`:

| What | Where | How |
|---|---|---|
| Vault path | environment | `CODEX_OBSIDIAN_VAULT=/path/to/CodexHistory` |
| Codex home | environment | `CODEX_HOME=/path/to/.codex` |
| Save delay | environment | `CODEX_OBSIDIAN_NOTIFY_DELAY_MS=5000` |
| Include tool calls/results | environment | `CODEX_OBSIDIAN_INCLUDE_TOOLS=1` |
| Existing notify command | environment | `CODEX_NOTIFY_FORWARD="/path/to/notify args"` |
| Role headings | `writeNote` → `heading` | change `User` / `Codex` headings |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Output says **"Raw Data (no transcript resolvable)"** | `transcript_path` was missing from the payload, or the JSONL file didn't exist at that path. Check `~/.claude/projects/<slug>/` still exists and contains `<session_id>.jsonl`. |
| No files appear in the vault at all | Hook not firing. Open `/hooks` in Claude Code (reloads the settings watcher), or restart. Check `$TMPDIR/claude-save-error.log`. |
| Settings seem to have "disappeared" after editing | You likely wrote malformed JSON or a flat `{ type, command }` under `Stop` instead of the `{ hooks: [...] }` wrapper. A single bad `settings.json` silently disables **every** setting in it. |
| Blocks appear but look empty | Claude Code payload shape may have shifted in a new release. Run `head -n 5 <transcript_path>` on a fresh session to inspect the current block shape, then adjust `renderContent`. |
| Last turn occasionally missing from a saved note | Stop hook can fire a few hundred ms before Claude Code flushes the latest assistant message to the JSONL — a race. The script handles this by polling: it compares the rendered tail against `last_assistant_message` from the hook payload and re-reads up to 5× / ~1s when behind. If you still see drops, raise the retry budget in `readTranscriptFresh`. |
| Codex note only contains the first few messages | Do not rely on a LaunchAgent watching `~/.codex/session_index.jsonl`; that file may update only when the session title/index changes. Use `codex-notify-wrapper.sh` so every Codex turn triggers a delayed background save. |
| Codex note does not update | Confirm `~/.codex/config.toml` points `notify` at `codex-notify-wrapper.sh`, confirm the wrapper is executable, then check `$TMPDIR/codex-save-error.log` and `$TMPDIR/codex-obsidian-save-debug.log`. |
| Codex Desktop reports plugin/Computer Use shutdown errors | Make sure `notify` points at `codex-notify-wrapper.sh`, not directly at `codex-obsidian-save.js`. The wrapper preserves the Computer Use notification path when the bundled plugin is installed. |

## License

MIT.
