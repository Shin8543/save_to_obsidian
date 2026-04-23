const fs = require('fs');
const path = require('path');
const os = require('os');

// Where to write session notes. Override with the CLAUDE_OBSIDIAN_VAULT env var
// when you wire this into your Stop hook, e.g.
//   "command": "CLAUDE_OBSIDIAN_VAULT=~/MyVault/ClaudeLogs node /path/to/obsidian-save.js"
// Falls back to ~/ClaudeHistory so a default install still produces something.
const RAW_PATH = process.env.CLAUDE_OBSIDIAN_VAULT || '~/ClaudeHistory';
const OBSIDIAN_VAULT_PATH = RAW_PATH.replace(/^~/, os.homedir());

function cleanContent(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// Turn an assistant/user message.content into a readable markdown string.
// content is either a plain string (legacy user text) or an array of blocks.
function renderContent(content) {
    if (typeof content === 'string') return cleanContent(content).trim();
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        switch (block.type) {
            case 'text':
                parts.push(cleanContent(block.text || ''));
                break;
            case 'thinking':
                // Collapse thinking into a callout so it's present but out of the way.
                if (block.thinking && block.thinking.trim()) {
                    parts.push(`> [!note]- thinking\n> ${cleanContent(block.thinking).replace(/\n/g, '\n> ')}`);
                }
                break;
            case 'tool_use': {
                const input = block.input ? JSON.stringify(block.input) : '';
                const preview = input.length > 400 ? input.slice(0, 400) + '…' : input;
                parts.push(`**🛠 ${block.name}** \`${preview}\``);
                break;
            }
            case 'tool_result': {
                const raw = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                        ? block.content.map(c => (c && c.type === 'text' ? c.text : '')).join('\n')
                        : '';
                const cleaned = cleanContent(raw).trim();
                if (!cleaned) break;
                const preview = cleaned.length > 800 ? cleaned.slice(0, 800) + '\n…(truncated)' : cleaned;
                parts.push(`> [!example]- tool_result\n> ${preview.replace(/\n/g, '\n> ')}`);
                break;
            }
            default:
                break;
        }
    }
    return parts.filter(Boolean).join('\n\n').trim();
}

function readTranscript(transcriptPath) {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    const turns = [];
    let firstUserText = '';
    let firstTimestamp = '';
    for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain) continue; // skip subagent internal traffic
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg) continue;
        const rendered = renderContent(msg.content);
        if (!rendered) continue;
        if (!firstTimestamp && entry.timestamp) firstTimestamp = entry.timestamp;
        // Capture the first real user prompt (not a tool_result echo) for the title.
        if (!firstUserText && entry.type === 'user' && typeof msg.content === 'string') {
            firstUserText = msg.content;
        }
        turns.push({ role: entry.type, timestamp: entry.timestamp, text: rendered });
    }
    return { turns, firstUserText, firstTimestamp };
}

// Derive a filesystem-safe title slug from the first user message.
// Claude Code's auto-generated session title lives server-side and isn't in the
// local transcript, so we approximate with the opening prompt. Good enough to
// scan the vault visually and search inside Obsidian.
function deriveTitleSlug(firstUserText) {
    if (!firstUserText) return 'untitled';
    let t = firstUserText
        // strip @file mentions and /slash-commands the user prefixed
        .replace(/@\/\S+/g, ' ')
        .replace(/\/[A-Za-z0-9_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // take first sentence-ish chunk
    t = t.split(/[\n。.!?！？]/)[0].trim();
    // strip filesystem-hostile chars; keep CJK, letters, digits, spaces, dashes
    t = t.replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 50) t = t.slice(0, 50).trim() + '…';
    return t || 'untitled';
}

// Find an existing note for this session so we can overwrite in place
// (incremental update — every Stop rewrites the full transcript for the session).
function findExistingForSession(dir, sessionId) {
    if (!sessionId || !fs.existsSync(dir)) return null;
    const suffix = `__${sessionId}.md`;
    for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(suffix)) return path.join(dir, name);
    }
    return null;
}

// Synchronous sleep — used by the freshness poll. Blocks the event loop, but
// the hook process exits right after writing so this is fine.
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Normalize text for prefix comparison (strip whitespace, control chars).
function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

// Read the transcript with a short retry loop. Claude Code may fire the Stop
// hook a few hundred ms before the latest assistant message is flushed to the
// JSONL, which would silently drop the final turn from our archive. We compare
// the freshly-read tail against `last_assistant_message` from the hook payload
// (which always reflects the actual latest message) and re-read if behind.
function readTranscriptFresh(transcriptPath, lastAssistantMessage) {
    const expected = normalize(lastAssistantMessage).slice(0, 80);
    const maxAttempts = expected ? 6 : 1; // ~1s budget when we have something to wait for
    let result = readTranscript(transcriptPath);
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
        if (!expected) break;
        // Find the most recent assistant turn's rendered text.
        const lastAssistant = [...result.turns].reverse().find(t => t.role === 'assistant');
        const got = normalize(lastAssistant && lastAssistant.text);
        // Match if the rendered turn text contains the expected prefix anywhere.
        // (Renderer may prepend tool_use lines etc., so we don't anchor to start.)
        if (got.includes(expected)) break;
        sleepSync(200);
        result = readTranscript(transcriptPath);
    }
    return result;
}

async function saveToObsidian() {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { input += data; });
    process.stdin.on('end', () => {
        if (!input.trim()) return;

        try {
            const sessionData = JSON.parse(input);
            const cwd = sessionData.cwd || '';
            const sessionId = sessionData.session_id || '';
            const transcriptPath = sessionData.transcript_path;
            const lastAssistantMessage = sessionData.last_assistant_message || '';

            let turns = [];
            let firstUserText = '';
            let firstTimestamp = '';
            if (transcriptPath && fs.existsSync(transcriptPath)) {
                ({ turns, firstUserText, firstTimestamp } = readTranscriptFresh(transcriptPath, lastAssistantMessage));
            }

            if (!fs.existsSync(OBSIDIAN_VAULT_PATH)) {
                fs.mkdirSync(OBSIDIAN_VAULT_PATH, { recursive: true });
            }

            // Incremental update: if we already have a file for this session_id,
            // overwrite it in place so Obsidian keeps the same note. Otherwise
            // construct a new name from the first user prompt + date + session id.
            let filePath = findExistingForSession(OBSIDIAN_VAULT_PATH, sessionId);
            const startDate = (firstTimestamp || new Date().toISOString()).split('T')[0];
            const dateStr = new Date().toISOString().split('T')[0];
            if (!filePath) {
                const slug = deriveTitleSlug(firstUserText);
                const fileName = `${startDate}_${slug}__${sessionId || 'no-session'}.md`;
                filePath = path.join(OBSIDIAN_VAULT_PATH, fileName);
            }

            const titleForHeading = deriveTitleSlug(firstUserText);
            let content = `---\n`;
            content += `date: ${startDate}\n`;
            content += `updated: ${dateStr}\n`;
            content += `type: claude-log\n`;
            content += `tags: [AI/Claude]\n`;
            if (cwd) content += `cwd: "${cwd}"\n`;
            if (sessionId) content += `session_id: ${sessionId}\n`;
            content += `---\n\n`;
            content += `# ${titleForHeading}\n\n`;

            if (turns.length) {
                for (const turn of turns) {
                    const heading = turn.role === 'user' ? '### 😏 User' : '### 🤖 Claude';
                    const ts = turn.timestamp ? ` _(${turn.timestamp})_` : '';
                    content += `${heading}${ts}\n\n${turn.text}\n\n---\n\n`;
                }
            } else {
                content += `## Raw Data (no transcript resolvable)\n\n\`\`\`json\n${JSON.stringify(sessionData, null, 2)}\n\`\`\`\n`;
            }

            fs.writeFileSync(filePath, content, 'utf8');
        } catch (err) {
            fs.appendFileSync(
                path.join(os.tmpdir(), 'claude-save-error.log'),
                `${new Date().toISOString()}: ${err.message}\n${err.stack}\n`
            );
        }
    });
}

saveToObsidian();
