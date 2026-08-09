#!/usr/bin/env bash
# 体检某个 bot 实例：./doctor.sh mybot
set -euo pipefail
cd "$(dirname "$0")"

SLUG="${1:?用法: ./doctor.sh <slug>}"
ENV_FILE="$HOME/.lark-agent/$SLUG/env"
[[ -f "$ENV_FILE" ]] || { echo "找不到 $ENV_FILE —— 这个实例还没建？"; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
# env 文件里没有 LARK_SLUG（那是 systemd 模板按 %i 注入的），这里补上 ——
# doctor.mts 靠它找 users.json、查可用范围、读实例日志。不传的话那几项静默跳过。
LARK_SLUG="$SLUG"
set +a

echo "── 体检 $SLUG ($LARK_APP_ID) ──"
node doctor.mts
