#!/usr/bin/env bash
# 宿主机凭证 ←→ 账号池 双向同步。
#
# 为什么需要：宿主机上你自己敲 claude、容器里跑任务，两边都会刷新同一个号的
# token，而**刷新会轮换 refresh token，旧的立即作废**。谁刷了谁不写回，
# 另一边下次就是 "OAuth session expired and could not be refreshed"。
#
# 容器那侧由 agent.mts 的 writeBack() 每轮结束写回；宿主机这侧没有钩子，
# 靠这个脚本兜（cron 每 10 分钟跑一次就够）。
#
# 规则：比 expiresAt，谁新用谁 —— 刷新过的那份一定更新。
set -euo pipefail

DIR="$HOME/.lark-agent/accounts"
HOST="$HOME/.claude/.credentials.json"
STATE="$DIR/state.json"

[[ -f "$HOST" ]] || { echo "宿主机没有凭证文件"; exit 0; }
[[ -d "$DIR" ]] || exit 0   # 没启用账号池

# 宿主机当前是池里的哪个号？按 refreshToken 认，不是按 state.current ——
# state.current 是容器那侧在用的号，宿主机可能登的是另一个。
name=$(python3 - <<'PY'
import json, os, glob
host = os.path.expanduser("~/.claude/.credentials.json")
try:
    rt = json.load(open(host))["claudeAiOauth"]["refreshToken"]
except Exception:
    print(""); raise SystemExit
for f in glob.glob(os.path.expanduser("~/.lark-agent/accounts/*.json")):
    if os.path.basename(f) == "state.json":
        continue
    try:
        if json.load(open(f))["claudeAiOauth"]["refreshToken"] == rt:
            print(os.path.basename(f)[:-5]); raise SystemExit
    except (KeyError, ValueError):
        continue
print("")
PY
)

if [[ -z "$name" ]]; then
  # refreshToken 对不上任何一个号 —— 说明宿主机刷新过了（token 已轮换），
  # 或者登了个池子外的号。用 expiresAt 判断是不是 state.current 的新版本。
  name=$(python3 -c "
import json,os
try: print(json.load(open('$STATE')).get('current',''))
except Exception: print('')")
  [[ -n "$name" ]] || { echo "认不出宿主机登的是哪个号，跳过"; exit 0; }
fi

POOL="$DIR/$name.json"
[[ -f "$POOL" ]] || { echo "池里没有 $name.json，跳过"; exit 0; }

newer=$(python3 - "$HOST" "$POOL" <<'PY'
import json, sys
def exp(p):
    try: return json.load(open(p))["claudeAiOauth"]["expiresAt"]
    except Exception: return -1
h, p = exp(sys.argv[1]), exp(sys.argv[2])
print("host" if h > p else ("pool" if p > h else "same"))
PY
)

case "$newer" in
  host) install -m 600 "$HOST" "$POOL"; echo "↑ 宿主机较新，已写回池子（$name）" ;;
  pool) install -m 600 "$POOL" "$HOST"; echo "↓ 池子较新，已更新宿主机（$name）" ;;
  same) echo "= $name 两边一致，无需同步" ;;
esac
