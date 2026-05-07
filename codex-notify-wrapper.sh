#!/bin/zsh
set -u

SCRIPT_DIR="${0:A:h}"
NODE_BIN="${NODE_BIN:-node}"
SAVE_SCRIPT="${CODEX_OBSIDIAN_SAVE_SCRIPT:-$SCRIPT_DIR/codex-obsidian-save.js}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

if command -v "$NODE_BIN" >/dev/null 2>&1 && [[ -f "$SAVE_SCRIPT" ]]; then
  "$NODE_BIN" "$SAVE_SCRIPT" --notify >/dev/null 2>&1
fi

if [[ "${CODEX_OBSIDIAN_SKIP_FORWARD:-0}" == "1" ]]; then
  exit 0
fi

if [[ -n "${CODEX_NOTIFY_FORWARD:-}" ]]; then
  exec /bin/zsh -lc "$CODEX_NOTIFY_FORWARD"
fi

SKY_CLIENTS=("$CODEX_HOME_DIR"/plugins/cache/openai-bundled/computer-use/*/Codex\ Computer\ Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient(N))
SKY_CLIENT="${SKY_CLIENTS[-1]:-}"

if [[ -n "$SKY_CLIENT" && -x "$SKY_CLIENT" ]]; then
  exec "$SKY_CLIENT" turn-ended
fi

exit 0
