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
#
# 分成两半，各归各管：
#   标记块内  平台侧内容，每次从 skel 覆盖 —— 改了 skel 所有实例自动拿到
#   标记块外  agent 自己攒的经验，永不动
#
# 原来的规则是「文件存在就整个不拷」，保住了 agent 的经验，但平台侧的更新
# 也推不下去 —— 一天里手动同步了三次（域名写错、发图方式变了、apt 开放）。
SKEL="$(cd "$(dirname "$0")" && pwd)/skel/CLAUDE.md"
if [[ -f "$SKEL" ]]; then
  python3 - "$SKEL" "$ROOT/workspace/CLAUDE.md" <<'PY'
import sys, os, re

skel_path, dest = sys.argv[1], sys.argv[2]
BEGIN = "<!-- lark-skel:begin 这块由 ensure.sh 从 docker/skel/CLAUDE.md 同步，改了会被覆盖 -->"
END   = "<!-- lark-skel:end 你自己的经验写在这行下面，不会被动 -->"

skel = open(skel_path, encoding="utf8").read().strip()
block = f"{BEGIN}\n\n{skel}\n\n{END}\n"

if not os.path.exists(dest):
    open(dest, "w", encoding="utf8").write(block)
    raise SystemExit

cur = open(dest, encoding="utf8").read()

if BEGIN in cur and END in cur:
    # 常规路径：只换块内，块外原样保留
    new = re.sub(
        re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?",
        lambda _: block,
        cur, count=1, flags=re.S,
    )
else:
    # 老文件没有标记：把 skel 作为新块放前面，原内容整体当成「agent 的经验」留在后面。
    # 宁可重复也不删 —— 删掉可能丢掉 agent 攒的东西，重复只是啰嗦。
    new = block + "\n" + cur.lstrip()

if new != cur:
    tmp = dest + ".tmp"
    open(tmp, "w", encoding="utf8").write(new)
    os.replace(tmp, dest)
PY
fi

# 凭证：每次都从宿主机同步，不能只在建容器时拷一次。
# 宿主机的 Claude Code 会定期刷新并轮换 refresh token，容器里的旧快照会失效，
# 表现为 "OAuth session expired and could not be refreshed"。
# 宿主机通常会提前刷新，所以同步过来的 access token 够跑完一轮，容器一般不需要自己刷新。
#
# 团队网关模式：Claude 用 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN，
# 不能再放 OAuth 凭证，否则 CLI 可能走 Max 登录而不是网关。令牌经 docker exec -e
# 注入（见 claude-exec.sh），不写进容器磁盘。
# 启用本地账号池时（~/.lark-agent/accounts/ 里有号），由桥接经 LARK_CRED_SRC
# 指定这一轮用哪个号；没启用就还是用宿主机自己那份。
if [[ -n "${ANTHROPIC_BASE_URL:-}" && -n "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
  rm -f "$ROOT/claude/.credentials.json"
else
  SRC="${LARK_CRED_SRC:-$HOME/.claude/.credentials.json}"
  if [[ -f "$SRC" ]]; then
    install -m 600 "$SRC" "$ROOT/claude/.credentials.json"
  fi
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
