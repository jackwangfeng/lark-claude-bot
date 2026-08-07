#!/usr/bin/env bash
# 往账号池里加一个 Claude 账号。
#
#   ./add-account.sh <名字>          把宿主机当前登录的号存进池子
#   ./add-account.sh <名字> --login  先登录（会覆盖宿主机当前登录状态）再存
#   ./add-account.sh --list          看池子
#
# 池子在 ~/.lark-agent/accounts/，一个号一个 json，格式就是 .credentials.json。
set -euo pipefail

DIR="$HOME/.lark-agent/accounts"
SRC="$HOME/.claude/.credentials.json"

if [[ "${1:-}" == "--list" ]]; then
  if [[ ! -d "$DIR" ]] || ! ls "$DIR"/*.json >/dev/null 2>&1; then
    echo "池子是空的（没启用多账号，用的是宿主机默认凭证）"
    exit 0
  fi
  cur=$(python3 -c "
import json,sys
try: print(json.load(open('$DIR/state.json')).get('current',''))
except Exception: print('')" 2>/dev/null)
  for f in "$DIR"/*.json; do
    n=$(basename "$f" .json)
    [[ "$n" == "state" ]] && continue
    exp=$(python3 -c "
import json,datetime
d=json.load(open('$f'))['claudeAiOauth']
print(datetime.datetime.fromtimestamp(d['refreshTokenExpiresAt']/1000).strftime('%Y-%m-%d'),
      d.get('subscriptionType','?'))" 2>/dev/null || echo "读取失败")
    [[ "$n" == "$cur" ]] && echo "▶ $n  $exp" || echo "  $n  $exp"
  done
  exit 0
fi

NAME="${1:?用法: add-account.sh <名字> [--login]   或   add-account.sh --list}"
[[ "$NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "名字只能用字母数字下划线连字符"; exit 1; }
[[ "$NAME" == "state" ]] || true

if [[ "${2:-}" == "--login" ]]; then
  echo "接下来会走 Claude 登录流程。"
  echo "⚠️ 这会覆盖宿主机当前的登录状态 —— 存进池子之后，宿主机上的 claude 命令"
  echo "   用的就是这个新号了。想换回去可以再 /login 一次。"
  read -rp "继续？[y/N] " a
  [[ "$a" == "y" || "$a" == "Y" ]] || exit 1
  claude /login
fi

[[ -f "$SRC" ]] || { echo "找不到 $SRC —— 先在宿主机上 claude /login"; exit 1; }

mkdir -p "$DIR"

# 同一个号别存两遍：refreshToken 一样就是同一个号
new_rt=$(python3 -c "import json;print(json.load(open('$SRC'))['claudeAiOauth']['refreshToken'])")
for f in "$DIR"/*.json; do
  [[ -e "$f" ]] || continue
  b=$(basename "$f" .json)
  [[ "$b" == "state" ]] && continue
  old_rt=$(python3 -c "
import json
try: print(json.load(open('$f'))['claudeAiOauth']['refreshToken'])
except Exception: print('')" 2>/dev/null)
  if [[ -n "$old_rt" && "$old_rt" == "$new_rt" && "$b" != "$NAME" ]]; then
    echo "⚠️ 这个号已经在池子里了，叫 '$b'。要换名字先删掉旧的。"
    exit 1
  fi
done

install -m 600 "$SRC" "$DIR/$NAME.json"
echo "✅ 已存入 $DIR/$NAME.json"

n=$(ls "$DIR"/*.json 2>/dev/null | grep -cv 'state\.json$' || echo 0)
echo "池子里现在有 $n 个号。"
if [[ "$n" -ge 2 ]]; then
  echo
  echo "多账号已生效 —— 一个号撞额度上限会自动切下一个，到点自动切回。"
  echo "记得重启实例：systemctl --user restart 'lark-claude@*'"
fi
