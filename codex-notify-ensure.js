#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');
const WRAPPER_PATH = process.env.CODEX_NOTIFY_WRAPPER || path.join(os.homedir(), '.ai-save-to-obsidian', 'codex-notify-wrapper.sh');
const LOG_PATH = path.join(os.tmpdir(), 'codex-notify-ensure.log');

function log(message) {
    try {
        fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Self-healing should never fail just because logging failed.
    }
}

function tomlString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function desiredNotifyLine() {
    return `notify = [${tomlString(WRAPPER_PATH)}]`;
}

function bracketDelta(line) {
    let delta = 0;
    let quote = null;
    let escaped = false;
    for (const ch of line) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (ch === '\\') escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[') delta += 1;
        else if (ch === ']') delta -= 1;
    }
    return delta;
}

function replaceNotify(content) {
    const lines = content.split('\n');
    const desired = desiredNotifyLine();
    const out = [];
    let changed = false;
    let replaced = false;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!replaced && /^\s*notify\s*=/.test(line)) {
            let depth = bracketDelta(line);
            while (depth > 0 && i + 1 < lines.length) {
                i += 1;
                depth += bracketDelta(lines[i]);
            }
            out.push(desired);
            replaced = true;
            changed = line.trim() !== desired;
            continue;
        }
        out.push(line);
    }

    if (!replaced) {
        const insertAt = out.findIndex(line => /^\s*\[/.test(line));
        if (insertAt >= 0) out.splice(insertAt, 0, '', desired, '');
        else out.push('', desired);
        changed = true;
    }

    return { content: out.join('\n'), changed };
}

function main() {
    if (!fs.existsSync(CONFIG_PATH)) {
        log(`skip missing config ${CONFIG_PATH}`);
        return;
    }
    if (!fs.existsSync(WRAPPER_PATH)) {
        log(`skip missing wrapper ${WRAPPER_PATH}`);
        return;
    }

    const before = fs.readFileSync(CONFIG_PATH, 'utf8');
    const { content, changed } = replaceNotify(before);
    if (!changed && before === content) return;

    const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    log(`repaired notify in ${CONFIG_PATH}`);
}

try {
    main();
} catch (err) {
    log(`error: ${err.stack || err.message}`);
    process.exitCode = 1;
}
