#!/usr/bin/env bash
# 启动一个 bot 实例。凭证优先从环境变量取（systemd 模板 unit 用 EnvironmentFile 注入），
# 没有再退回 ~/.claude/channels/feishu/.env，方便手工跑。
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${LARK_APP_ID:-}" || -z "${LARK_APP_SECRET:-}" ]]; then
  ENV_FILE="${LARK_ENV_FILE:-$HOME/.claude/channels/feishu/.env}"
  [[ -f "$ENV_FILE" ]] || { echo "没有 LARK_APP_ID/SECRET，也找不到 $ENV_FILE"; exit 1; }
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  export LARK_APP_ID="${LARK_APP_ID:-${FEISHU_APP_ID:?缺少 APP ID}}"
  export LARK_APP_SECRET="${LARK_APP_SECRET:-${FEISHU_APP_SECRET:?缺少 APP SECRET}}"
fi

export LARK_SLUG="${LARK_SLUG:-default}"

# 这台机器有三个 node：/usr/bin(18)、/usr/local/bin(22.14)、nvm(24)。
# systemd 的 PATH 会先命中 /usr/local/bin 那个，但 .mts 需要 22.18+ 才能原生剥离类型，
# 所以「找得到 node 就用」是不够的 —— 必须校验版本，不达标就走 nvm。
MIN_MAJOR=22
MIN_MINOR=18

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v 2>/dev/null)"; v="${v#v}"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [[ "$major" -gt "$MIN_MAJOR" ]] && return 0
  [[ "$major" -eq "$MIN_MAJOR" && "$minor" -ge "$MIN_MINOR" ]]
}

if ! node_ok; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
node_ok || {
  echo "需要 node >= ${MIN_MAJOR}.${MIN_MINOR}（.mts 原生类型剥离），当前 $(node -v 2>/dev/null || echo 未安装)"
  exit 1
}
echo "node $(node -v) @ $(command -v node)"

exec node index.mts
