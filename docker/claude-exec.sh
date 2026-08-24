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
# LARK_CHAT_ID：容器内脚本想知道「我在跟哪个会话说话」时用。
# 发图不再依赖它（改用 plugins/image.mts，跑在宿主机），但留着无害。
# GITHUB_TOKEN 给 gh 用 —— gh 自动认这个变量，不用 gh auth login。
# （原来走远程 github MCP 时 token 在宿主机侧展开，不需要进容器；换 gh 就必须传。）
#
# 团队网关：把 BASE_URL / AUTH_TOKEN 注进这一轮 claude 进程，不写磁盘。
# 明确不传 ANTHROPIC_API_KEY —— 有它会走按量 API 而不是 Max 池。
EXEC_ENV=(
  -e "LARK_TURN_ID=${LARK_TURN_ID:-}"
  -e "LARK_APP_ID=${LARK_APP_ID:-}"
  -e "LARK_APP_SECRET=${LARK_APP_SECRET:-}"
  -e "LARK_MCP_DOMAIN=${LARK_MCP_DOMAIN:-}"
  -e "GITHUB_TOKEN=${GITHUB_TOKEN:-}"
  -e "LARK_CHAT_ID=${LARK_CHAT_ID:-}"
)
if [[ -n "${ANTHROPIC_BASE_URL:-}" && -n "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
  EXEC_ENV+=(-e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}")
  EXEC_ENV+=(-e "ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN}")
fi
exec docker exec -i \
  -w "${LARK_WORKDIR:-/workspace}" \
  "${EXEC_ENV[@]}" \
  "$LARK_CONTAINER" claude "$@"
