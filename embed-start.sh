#!/usr/bin/env bash
# 启动向量化服务。
#
# env -i 清空环境：很多机器的登录 shell 里有 ALL_PROXY=socks5://…，
# huggingface_hub 会尝试走它，而 httpx 没装 socks 扩展 → 直接 ImportError。
# 这个服务只读本地模型缓存，不需要任何代理。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

exec env -i \
  HOME="$HOME" \
  PATH=/usr/bin:/bin \
  HF_HUB_OFFLINE=1 \
  HF_HOME="$HOME/.cache/huggingface" \
  HUGGINGFACE_HUB_CACHE="$HOME/.cache/huggingface/hub" \
  NO_PROXY='*' no_proxy='*' \
  EMBED_PORT="${EMBED_PORT:-8181}" \
  CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}" \
  "$HERE/.venv/bin/python" "$HERE/embed-server.py"
