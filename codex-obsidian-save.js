const fs = require('fs');
const path = require('path');
const os = require('os');

// Where to write session notes. Override with CODEX_OBSIDIAN_VAULT.
// Example:
//   CODEX_OBSIDIAN_VAULT=~/Obsidian/Vault/CodexHistory node codex-obsidian-save.js
const DEFAULT_VAULT = '~/CodexHistory';
const DEFAULT_CODEX_HOME = '~/.codex';
const RAW_VAULT_PATH = process.env.CODEX_OBSIDIAN_VAULT || DEFAULT_VAULT;
const RAW_CODEX_HOME = process.env.CODEX_HOME || DEFAULT_CODEX_HOME;
const OBSIDIAN_VAULT_PATH = expandHome(RAW_VAULT_PATH);
const CODEX_HOME = expandHome(RAW_CODEX_HOME);
const ERROR_LOG = path.join(os.tmpdir(), 'codex-save-error.log');
const DEBUG_LOG = path.join(os.tmpdir(), 'codex-obsidian-save-debug.log');
const NOTIFY_DELAY_MS = Number(process.env.CODEX_OBSIDIAN_NOTIFY_DELAY_MS || 5000);

function expandHome(p) {
    return (p || '').replace(/^~(?=$|\/)/, os.homedir());
}

function cleanContent(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function truncate(text, max) {
    if (!text || text.length <= max) return text || '';
    return text.slice(0, max) + '\n...(truncated)';
}

function sleepSync(ms) {
    if (!ms || ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function debugLog(message) {
    try {
        fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Debug logging should never prevent archiving.
    }
}

function fence(text) {
    const body = cleanContent(text || '').trim();
    if (!body) return '';
    const ticks = body.includes('```') ? '````' : '```';
    return `${ticks}\n${body}\n${ticks}`;
}

function renderContent(content) {
    if (typeof content === 'string') return cleanContent(content).trim();
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        switch (block.type) {
            case 'input_text':
            case 'output_text':
            case 'text':
                parts.push(cleanContent(block.text || ''));
                break;
            case 'image_url':
                parts.push(`[image](${block.image_url && block.image_url.url ? block.image_url.url : 'attached image'})`);
                break;
            case 'local_image':
                parts.push(`[local image](${block.path || 'attached image'})`);
                break;
            default:
                break;
        }
    }
    return parts.filter(Boolean).join('\n\n').trim();
}

function renderFunctionCall(payload) {
    const name = payload.name || 'tool';
    const args = payload.arguments || payload.input || '';
    const preview = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
    return `**Tool call: ${name}**\n\n${fence(truncate(preview, 1200))}`;
}

function renderFunctionOutput(payload) {
    const raw = payload.output || payload.result || '';
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    const body = truncate(cleanContent(text).trim(), 2000);
    if (!body) return '';
    return `> [!example]- tool result\n> ${body.replace(/\n/g, '\n> ')}`;
}

function isSyntheticUserText(text) {
    const t = (text || '').trim();
    return t.startsWith('<environment_context>') || t.startsWith('<skill>');
}

function extractSessionIdFromPath(filePath) {
    const base = path.basename(filePath || '');
    const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1] : '';
}

function readSessionIndex(codexHome) {
    const titles = new Map();
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    if (!fs.existsSync(indexPath)) return titles;

    for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.id && entry.thread_name) titles.set(entry.id, entry.thread_name);
        } catch {
            // Ignore partial/corrupt index lines.
        }
    }
    return titles;
}

function readCodexTranscript(filePath, titles) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const turns = [];
    const meta = {
        sessionId: extractSessionIdFromPath(filePath),
        cwd: '',
        originator: '',
        source: '',
        cliVersion: '',
        title: '',
        firstUserText: '',
        firstTimestamp: '',
        updatedTimestamp: '',
    };

    for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }

        if (entry.timestamp) {
            if (!meta.firstTimestamp) meta.firstTimestamp = entry.timestamp;
            meta.updatedTimestamp = entry.timestamp;
        }

        if (entry.type === 'session_meta' && entry.payload) {
            const p = entry.payload;
            meta.sessionId = p.id || meta.sessionId;
            meta.cwd = p.cwd || meta.cwd;
            meta.originator = p.originator || meta.originator;
            meta.source = p.source || meta.source;
            meta.cliVersion = p.cli_version || meta.cliVersion;
            continue;
        }

        if (entry.type !== 'response_item' || !entry.payload) continue;
        const payload = entry.payload;

        if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
            const rendered = renderContent(payload.content);
            if (!rendered) continue;
            if (payload.role === 'user' && isSyntheticUserText(rendered)) continue;
            if (!meta.firstUserText && payload.role === 'user') meta.firstUserText = rendered;
            turns.push({
                role: payload.role,
                timestamp: entry.timestamp,
                text: rendered,
            });
            continue;
        }

        if (process.env.CODEX_OBSIDIAN_INCLUDE_TOOLS === '1' && payload.type === 'function_call') {
            const rendered = renderFunctionCall(payload);
            if (rendered) turns.push({ role: 'tool', timestamp: entry.timestamp, text: rendered });
            continue;
        }

        if (process.env.CODEX_OBSIDIAN_INCLUDE_TOOLS === '1' && payload.type === 'function_call_output') {
            const rendered = renderFunctionOutput(payload);
            if (rendered) turns.push({ role: 'tool', timestamp: entry.timestamp, text: rendered });
        }
    }

    meta.title = titles.get(meta.sessionId) || deriveTitleSlug(meta.firstUserText);
    return { meta, turns };
}

function deriveTitleSlug(firstUserText) {
    if (!firstUserText) return 'untitled';
    let t = firstUserText
        .replace(/@\/\S+/g, ' ')
        .replace(/\/[A-Za-z0-9_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    t = t.split(/[\n。.!?！？]/)[0].trim();
    t = t.replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 50) t = t.slice(0, 50).trim() + '...';
    return t || 'untitled';
}

function fileSafeTitle(title) {
    const cleaned = (title || 'untitled')
        .replace(/[\/\\:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.slice(0, 70) || 'untitled';
}

function findExistingForSession(dir, sessionId) {
    if (!sessionId || !fs.existsSync(dir)) return null;
    const suffix = `__${sessionId}.md`;
    for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(suffix)) return path.join(dir, name);
    }
    return null;
}

function yamlString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function writeNote(transcriptPath) {
    const titles = readSessionIndex(CODEX_HOME);
    const { meta, turns } = readCodexTranscript(transcriptPath, titles);
    fs.mkdirSync(OBSIDIAN_VAULT_PATH, { recursive: true });

    const startIso = meta.firstTimestamp || new Date().toISOString();
    const startDate = startIso.split('T')[0];
    const updatedDate = (meta.updatedTimestamp || new Date().toISOString()).split('T')[0];
    const sessionId = meta.sessionId || 'no-session';
    let filePath = findExistingForSession(OBSIDIAN_VAULT_PATH, sessionId);
    if (!filePath) {
        filePath = path.join(OBSIDIAN_VAULT_PATH, `${startDate}_${fileSafeTitle(meta.title)}__${sessionId}.md`);
    }

    let content = '---\n';
    content += `date: ${startDate}\n`;
    content += `updated: ${updatedDate}\n`;
    content += 'type: codex-log\n';
    content += 'tags: [AI/Codex]\n';
    content += `session_id: ${sessionId}\n`;
    content += `transcript_path: "${yamlString(transcriptPath)}"\n`;
    if (meta.cwd) content += `cwd: "${yamlString(meta.cwd)}"\n`;
    if (meta.originator) content += `originator: "${yamlString(meta.originator)}"\n`;
    if (meta.source) content += `source: "${yamlString(meta.source)}"\n`;
    if (meta.cliVersion) content += `cli_version: "${yamlString(meta.cliVersion)}"\n`;
    content += '---\n\n';
    content += `# ${meta.title || 'untitled'}\n\n`;

    if (turns.length) {
        for (const turn of turns) {
            let heading = '### Tool';
            if (turn.role === 'user') heading = '### 😏 User';
            if (turn.role === 'assistant') heading = '### 🤖 Codex';
            const ts = turn.timestamp ? ` _(${turn.timestamp})_` : '';
            content += `${heading}${ts}\n\n${turn.text}\n\n---\n\n`;
        }
    } else {
        content += '## Raw Data (no user/assistant messages found)\n\n';
        content += fence(fs.readFileSync(transcriptPath, 'utf8'));
        content += '\n';
    }

    fs.writeFileSync(filePath, content, 'utf8');
    debugLog(`wrote ${filePath}`);
    return filePath;
}

function walkJsonlFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkJsonlFiles(p, out);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            out.push(p);
        }
    }
    return out;
}

function listCodexTranscripts() {
    const files = [
        ...walkJsonlFiles(path.join(CODEX_HOME, 'sessions')),
        ...walkJsonlFiles(path.join(CODEX_HOME, 'archived_sessions')),
    ];
    const unique = new Map();
    for (const file of files) {
        const id = extractSessionIdFromPath(file) || file;
        const prev = unique.get(id);
        if (!prev || fs.statSync(file).mtimeMs > fs.statSync(prev).mtimeMs) unique.set(id, file);
    }
    return [...unique.values()].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function findTranscriptBySessionId(sessionId) {
    if (!sessionId) return null;
    return listCodexTranscripts().find(file => extractSessionIdFromPath(file) === sessionId) || null;
}

function readStdinPayload() {
    if (process.stdin.isTTY) return null;
    try {
        const input = fs.readFileSync(0, 'utf8').trim();
        if (!input) return null;
        try {
            return JSON.parse(input);
        } catch {
            return { transcript_path: input };
        }
    } catch {
        return null;
    }
}

function parseArgs(argv) {
    const args = { all: false, latest: false, notify: false, backgroundSave: false, file: '', sessionId: '', days: 0 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--all') args.all = true;
        else if (arg === '--latest') args.latest = true;
        else if (arg === '--notify') args.notify = true;
        else if (arg === '--background-save') args.backgroundSave = true;
        else if (arg === '--file') args.file = expandHome(argv[++i] || '');
        else if (arg === '--session') args.sessionId = argv[++i] || '';
        else if (arg === '--days') args.days = Number(argv[++i] || 0);
    }
    return args;
}

function startBackgroundSave() {
    const { spawn } = require('child_process');
    debugLog(`notify received; spawning ${process.execPath} ${__filename} --background-save`);
    const child = spawn(process.execPath, [__filename, '--background-save'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            CODEX_OBSIDIAN_QUIET: '1',
        },
    });
    child.on('error', err => debugLog(`spawn error: ${err.message}`));
    child.unref();
}

function transcriptFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const file = payload.transcript_path || payload.transcriptPath || payload.path || payload.file || payload.session_path;
    if (file && fs.existsSync(expandHome(file))) return expandHome(file);
    const sessionId = payload.session_id || payload.sessionId || payload.thread_id || payload.threadId || payload.id;
    return findTranscriptBySessionId(sessionId);
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.notify) {
        // Notify runs before Codex fully finishes writing the turn. Start a
        // detached saver and return immediately so Codex can flush final_answer.
        startBackgroundSave();
        return;
    }

    if (args.backgroundSave) {
        debugLog(`background-save sleeping ${NOTIFY_DELAY_MS}ms`);
        sleepSync(NOTIFY_DELAY_MS);
    }

    const payload = readStdinPayload();
    const written = [];

    if (args.all) {
        const cutoff = args.days > 0 ? Date.now() - args.days * 24 * 60 * 60 * 1000 : 0;
        for (const file of listCodexTranscripts()) {
            if (cutoff && fs.statSync(file).mtimeMs < cutoff) continue;
            written.push(writeNote(file));
        }
    } else {
        const file =
            args.file ||
            findTranscriptBySessionId(args.sessionId) ||
            transcriptFromPayload(payload) ||
            listCodexTranscripts()[0];
        if (!file) throw new Error(`No Codex transcript found under ${CODEX_HOME}`);
        written.push(writeNote(file));
    }

    if (process.env.CODEX_OBSIDIAN_QUIET !== '1') {
        for (const file of written) console.log(file);
    }
}

try {
    main();
} catch (err) {
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()}: ${err.message}\n${err.stack}\n`);
    process.exitCode = 1;
}
