#!/usr/bin/env bash
# SDK 把这个脚本当作 claude 可执行文件来 spawn。
# stdin/stdout 上跑的是 stream-json 协议，docker exec -i 原样透传，协议不用改。
# 容器名由 agent.mjs 通过 options.env 注入。
set -euo pipefail
: "${LARK_CONTAINER:?claude-exec.sh 需要 LARK_CONTAINER 环境变量}"
# 不能加 -t：加了会分配 tty，把 stdout 变成行缓冲的终端流，JSON Lines 会被打乱
# LARK_TURN_ID 注入到容器进程的环境里，中断后靠它精确找回这一轮的进程去回收
# （一个容器服务多个会话，不能无差别 pkill claude）
# LARK_APP_ID/SECRET 给容器内的 lark-mcp 用（查群成员、搜文档等）。
# 注意 MCP server 是 CLI 在容器里 spawn 的，所以凭证必须进容器。
exec docker exec -i \
  -w "${LARK_WORKDIR:-/workspace}" \
  -e "LARK_TURN_ID=${LARK_TURN_ID:-}" \
  -e "LARK_APP_ID=${LARK_APP_ID:-}" \
  -e "LARK_APP_SECRET=${LARK_APP_SECRET:-}" \
  -e "LARK_MCP_DOMAIN=${LARK_MCP_DOMAIN:-}" \
  "$LARK_CONTAINER" claude "$@"
