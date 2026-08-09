#!/usr/bin/env bash
# 重启实例，但先等正在跑的轮次结束 —— 直接 restart 会掐断对话：
# 容器内进程被回收、审批通道断开，agent 那边看到的是
# 「Tool permission request failed: AbortError: Stream closed」，
# 而且它多半会误判成权限配置问题（实测 masa 那次就是）。
#
# 用法: ./restart-safe.sh [slug...]     不给参数则全部实例
set -euo pipefail
cd "$(dirname "$0")"

WAIT_MAX="${RESTART_WAIT_MAX:-180}"

slugs=("$@")
if [ ${#slugs[@]} -eq 0 ]; then
  mapfile -t slugs < <(systemctl --user list-units 'lark-claude@*' --no-legend \
    | awk '{print $1}' | sed 's/lark-claude@//; s/\.service//')
fi

for s in "${slugs[@]}"; do
  # 「跑着」的判据：容器里有带 LARK_TURN_ID 的 claude 进程
  waited=0
  while [ "$waited" -lt "$WAIT_MAX" ]; do
    busy=$(docker exec "lark-$s" sh -c \
      'for d in /proc/[0-9]*; do tr "\0" "\n" < "$d/environ" 2>/dev/null | grep -q "^LARK_TURN_ID=" && echo x; done | wc -l' \
      2>/dev/null || echo 0)
    [ "${busy:-0}" -eq 0 ] && break
    [ "$waited" -eq 0 ] && echo "  $s 正在跑，等它结束…"
    sleep 5; waited=$((waited+5))
  done
  [ "$waited" -ge "$WAIT_MAX" ] && echo "  ⚠️ $s 等了 ${WAIT_MAX}s 还在跑，强制重启（这一轮会被掐断）"
  systemctl --user restart "lark-claude@$s"
  printf "  %-8s %s\n" "$s" "$(systemctl --user is-active "lark-claude@$s")"
done
