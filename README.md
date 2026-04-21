# claude-save-to-obsidian

A tiny [Claude Code](https://claude.com/claude-code) **Stop hook** that archives every conversation to your Obsidian vault as a clean, incrementally-updated Markdown note.

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

## Install

### 1. Get the script somewhere stable

```bash
git clone https://github.com/<you>/claude-save-to-obsidian.git ~/.claude-save-to-obsidian
```

Any path works — `~/.agent/`, `~/bin/`, wherever you keep scripts. The hook just needs to know where to find `obsidian-save.js`.

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
            "command": "CLAUDE_OBSIDIAN_VAULT=~/Obsidian/Vault/Claude_History node ~/.claude-save-to-obsidian/obsidian-save.js",
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

## How it works

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

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Output says **"Raw Data (no transcript resolvable)"** | `transcript_path` was missing from the payload, or the JSONL file didn't exist at that path. Check `~/.claude/projects/<slug>/` still exists and contains `<session_id>.jsonl`. |
| No files appear in the vault at all | Hook not firing. Open `/hooks` in Claude Code (reloads the settings watcher), or restart. Check `$TMPDIR/claude-save-error.log`. |
| Settings seem to have "disappeared" after editing | You likely wrote malformed JSON or a flat `{ type, command }` under `Stop` instead of the `{ hooks: [...] }` wrapper. A single bad `settings.json` silently disables **every** setting in it. |
| Blocks appear but look empty | Claude Code payload shape may have shifted in a new release. Run `head -n 5 <transcript_path>` on a fresh session to inspect the current block shape, then adjust `renderContent`. |

## License

MIT.
