#!/usr/bin/env bash
# 确保某个 Lark 用户的容器存在且在跑。幂等，每轮对话前调一次。
# 用法：ensure.sh <slug>     输出：容器名
set -euo pipefail

SLUG="${1:?用法: ensure.sh <slug>}"
NAME="lark-${SLUG}"
IMAGE="${LARK_IMAGE:-lark-claude-agent:latest}"
ROOT="$HOME/.lark-agent/containers/$SLUG"
PROXY="${LARK_CONTAINER_PROXY:-http://host.docker.internal:8890}"

mkdir -p "$ROOT/claude" "$ROOT/workspace"

# 把环境相关的注意事项放进工作区。Agent SDK 默认加载 project 设置，
# /workspace/CLAUDE.md 每轮都会自动读到 —— 比写在 systemPrompt 里更靠前、更具体。
# 只在不存在时拷：agent 自己往里追加的经验不能被覆盖掉。
SKEL="$(cd "$(dirname "$0")" && pwd)/skel/CLAUDE.md"
if [[ -f "$SKEL" && ! -f "$ROOT/workspace/CLAUDE.md" ]]; then
  cp "$SKEL" "$ROOT/workspace/CLAUDE.md"
fi

# 凭证：每次都从宿主机同步，不能只在建容器时拷一次。
# 宿主机的 Claude Code 会定期刷新并轮换 refresh token，容器里的旧快照会失效，
# 表现为 "OAuth session expired and could not be refreshed"。
# 宿主机通常会提前刷新，所以同步过来的 access token 够跑完一轮，容器一般不需要自己刷新。
#
# 启用多账号池时（~/.lark-agent/accounts/ 里有号），由桥接经 LARK_CRED_SRC
# 指定这一轮用哪个号；没启用就还是用宿主机自己那份。
SRC="${LARK_CRED_SRC:-$HOME/.claude/.credentials.json}"
if [[ -f "$SRC" ]]; then
  install -m 600 "$SRC" "$ROOT/claude/.credentials.json"
fi

# 允许 agent 自己 sudo apt-get 装系统包。
#
# 默认开（LARK_ALLOW_APT=false 可关）。代价说清楚：
#   · sudo apt-get 实质等于容器内 root（deb 的 postinst 以 root 跑）
#   · 所以必须去掉 no-new-privileges（setuid 的 sudo 需要它），
#     并补回 dpkg 要的 capability，否则 apt 会在 chown/setuid 那步失败
# 接受这个代价的理由：容器内 root ≠ 宿主机 root —— 没挂 docker socket，
# 凭证本来就在容器里。真要给完全不信任的人用，把这个关掉。
#
# ⚠️ apt 装的东西在容器层，`docker rm` 就没了。要持久请装进 /workspace
# （npm -g 改 prefix、或下二进制），或者干脆加进 Dockerfile。
if [[ "${LARK_ALLOW_APT:-true}" == "true" ]]; then
  SEC_OPTS=(--cap-drop=ALL
            --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=FOWNER
            --cap-add=SETUID --cap-add=SETGID --cap-add=FSETID)
else
  SEC_OPTS=(--cap-drop=ALL --security-opt no-new-privileges)
fi

if ! docker container inspect "$NAME" >/dev/null 2>&1; then
  docker run -d --name "$NAME" \
    --add-host=host.docker.internal:host-gateway \
    -e HTTP_PROXY="$PROXY" -e HTTPS_PROXY="$PROXY" \
    -e http_proxy="$PROXY" -e https_proxy="$PROXY" \
    -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
    -e NODE_USE_ENV_PROXY=1 \
    -e TZ="${TZ:-$(cat /etc/timezone 2>/dev/null || echo Asia/Shanghai)}" \
    -v "$ROOT/claude:/home/node/.claude" \
    -v "$ROOT/workspace:/workspace" \
    "${SEC_OPTS[@]}" \
    --memory="${LARK_MEM:-4g}" --cpus="${LARK_CPUS:-2}" --pids-limit="${LARK_PIDS:-512}" \
    --restart unless-stopped \
    "$IMAGE" >/dev/null
elif [[ "$(docker container inspect -f '{{.State.Running}}' "$NAME")" != "true" ]]; then
  docker start "$NAME" >/dev/null
fi

echo "$NAME"
