#!/usr/bin/env bash
# 新建一个 bot 实例。
#
# 前提：先有 Lark 应用。推荐扫码创建（会预置权限、免发版）：
#   .venv/bin/python register-app.py <名称> "<描述>"
#   ⚠️ 确认页必须选「智能体」—— 机器人类型私聊输入框不可用。
#
# 本脚本做完这些：解析白名单 → 写凭证/白名单 → 加入应用可用范围 → 注册 systemd → 启动 → 验活
#
# 用法：
#   ./new-bot.sh <slug> <app_id> <app_secret> [白名单,逗号分隔]
#
# 白名单可混填 union_id(on_) / open_id(ou_) / 邮箱 / 手机号，
# 后两者会借「管理实例」（默认 admin，见 LARK_LOOKUP_SLUG）查成 union_id。
# 例：
#   ./new-bot.sh alice cli_xxx yyy alice@corp.com
#   ./new-bot.sh bob   cli_yyy zzz on_1234,bob@corp.com
set -euo pipefail

SLUG="${1:-}"
APP_ID="${2:-}"
APP_SECRET="${3:-}"
OPEN_IDS="${4:-}"

if [[ -z "$SLUG" || -z "$APP_ID" || -z "$APP_SECRET" ]]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "slug 只能用小写字母/数字/-/_，且以字母数字开头"; exit 1; }

ROOT="$HOME/.lark-agent/$SLUG"
UNIT="lark-claude@${SLUG}"

if systemctl --user is-enabled "$UNIT" >/dev/null 2>&1; then
  echo "⚠️  实例 $UNIT 已存在。改配置请直接编辑 $ROOT/env 后 restart。"
  exit 1
fi

mkdir -p "$ROOT"

# 凭证：只有本人可读
umask 077
cat > "$ROOT/env" <<EOF
LARK_APP_ID=$APP_ID
LARK_APP_SECRET=$APP_SECRET
EOF
umask 022

# 「管理实例」：集中放跨应用能力（contact:user.id:readonly 查通讯录、
# admin:app.visibility 改任意应用的可用范围）。其他 bot 都不需要这些权限。
LOOKUP="${LARK_LOOKUP_SLUG:-admin}"
LOOKUP_ENV="$HOME/.lark-agent/$LOOKUP/env"

# 第四个参数支持混填 open_id / union_id / 邮箱 / 手机号。
# 邮箱和手机号查出来的是 union_id —— 不能用 open_id，那个按应用隔离，
# 拿管理实例查到的 open_id 填进新 bot 的白名单永远匹配不上且没有报错。
if [[ -n "$OPEN_IDS" ]]; then
  RESOLVED=""
  IFS=',' read -ra RAW <<< "$OPEN_IDS"
  for k in "${RAW[@]}"; do
    k="$(echo "$k" | tr -d ' ')"
    [[ -z "$k" ]] && continue
    if [[ "$k" == ou_* || "$k" == on_* ]]; then
      RESOLVED="${RESOLVED:+$RESOLVED,}$k"
    else
      if [[ ! -f "$LOOKUP_ENV" ]]; then
        echo "❌ 要用邮箱/手机号填白名单，需要一个有 contact:user.id:readonly 权限的实例。"
        echo "   没找到 $LOOKUP_ENV。改用 on_/ou_ 开头的 ID，或设 LARK_LOOKUP_SLUG=<实例名>。"
        exit 1
      fi
      echo "查询 $k …（借用管理实例 $LOOKUP）"
      # ⚠️ Lark SDK 的 logger 打在 stdout（不是 stderr），2>/dev/null 挡不住，
      #    直接 cut -f1 会把 "[info]: [ 'client ready' ]" 当成 ID。只认 ID 格式的行。
      id="$(set -a; . "$LOOKUP_ENV"; set +a
            node whois.mts "$k" 2>/dev/null | grep -oE '^(on_|ou_)[A-Za-z0-9]+' | head -1)" || true
      if [[ -z "$id" ]]; then
        echo "❌ $k 查不到 union_id。"
        echo "   可能是：不在通讯录 / 不在 $LOOKUP 的通讯录权限范围内 / 邮箱写错。"
        echo "   改用 on_ 开头的 union_id，或留空后用日志法。"
        exit 1
      fi
      echo "   → $id"
      RESOLVED="${RESOLVED:+$RESOLVED,}$id"
    fi
  done
  OPEN_IDS="$RESOLVED"
fi

# 私聊白名单。群聊是「谁 @ 都服务」，不看这个表。
if [[ ! -f "$ROOT/users.json" ]]; then
  if [[ -n "$OPEN_IDS" ]]; then
    {
      echo '{'
      IFS=',' read -ra IDS <<< "$OPEN_IDS"
      for i in "${!IDS[@]}"; do
        id="$(echo "${IDS[$i]}" | tr -d ' ')"
        [[ -z "$id" ]] && continue
        sep=','; [[ $i -eq $((${#IDS[@]} - 1)) ]] && sep=''
        printf '  "%s": { "slug": "%s" }%s\n' "$id" "$SLUG" "$sep"
      done
      echo '}'
    } > "$ROOT/users.json"
  else
    echo '{}' > "$ROOT/users.json"
  fi
fi

# 把白名单里的人加进新应用的「可用范围」。
# 不在可用范围内的人，在 Lark 里搜不到这个机器人 / 输入框不可用 —— 而权限、长连接
# 全是绿的，极易误判成代码问题。扫码创建只会把创建者放进去，其他人得手动加。
# 需要管理实例有 admin:app.visibility（租户级，能改任意应用）。
VIS_OK=""
if [[ -n "$OPEN_IDS" && -f "$LOOKUP_ENV" ]]; then
  echo
  echo "加入可用范围（借用管理实例 $LOOKUP）…"
  if (set -a; . "$LOOKUP_ENV"; set +a
      LARK_TARGET_APP_ID="$APP_ID" node grant-visibility.mts ${OPEN_IDS//,/ }) 2>&1 | sed 's/^/   /'; then
    VIS_OK="yes"
  else
    echo "   ⚠️  加可用范围失败 —— 实例照常建，但对方可能私聊不了。"
    echo "      要么给管理实例 $LOOKUP 加 admin:app.visibility 权限，"
    echo "      要么去后台手动加：该应用 → 可用范围 → 添加成员"
  fi
fi

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

sleep 5
echo
echo "════════════════════════════════════════════"
systemctl --user is-active "$UNIT" >/dev/null 2>&1 \
  && echo "✅ $UNIT 已启动" \
  || { echo "❌ 启动失败，看日志："; journalctl --user -u "$UNIT" -n 20 --no-pager -o cat; exit 1; }
journalctl --user -u "$UNIT" --since "10 seconds ago" --no-pager -o cat | grep -E "机器人|已启动" || true
echo
[[ -n "$VIS_OK" ]] && echo "✅ 白名单成员已加入应用可用范围"
echo "状态目录 : $ROOT"
echo "白名单   : $ROOT/users.json   （改完即刻生效，不用重启）"
echo "容器     : lark-$SLUG         （首条消息时自动创建）"
echo "日志     : journalctl --user -u $UNIT -f"
echo
if [[ -z "$OPEN_IDS" ]]; then
  echo "⚠️  白名单是空的，现在没人能私聊它。"
  echo "   让对方先私聊发一句，然后从日志里取 open_id："
  echo "   journalctl --user -u $UNIT -f | grep 未授权"
fi
echo "════════════════════════════════════════════"
