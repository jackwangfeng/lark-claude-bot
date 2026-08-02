#!/usr/bin/env bash
# 一次性安装：装依赖、建库、装 systemd 模板。
# 装完用 register-app.py + new-bot.sh 创建具体的 bot 实例。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()  { printf '  ✅ %s\n' "$1"; }
bad() { printf '  ❌ %s\n' "$1"; }

# ── Node ────────────────────────────────────────────────────────────────
say "检查 Node"
# .mts 原生类型剥离要 22.18+；很多机器上 /usr/local/bin 有个更旧的 node，
# 所以必须校验版本而不是「找得到就行」
node_major_minor() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1,2; }
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
V="$(node_major_minor || echo 0.0)"
MAJ="${V%%.*}"; MIN="${V#*.}"
if [[ "${MAJ:-0}" -gt 22 || ( "${MAJ:-0}" -eq 22 && "${MIN:-0}" -ge 18 ) ]]; then
  ok "node $(node -v)"
else
  bad "需要 node >= 22.18（.mts 原生类型剥离），当前 $(node -v 2>/dev/null || echo 未安装)"
  exit 1
fi

say "安装 npm 依赖"
npm install --silent && ok "完成"

say "类型检查"
npx tsc --noEmit && ok "无类型错误"

# ── PostgreSQL ──────────────────────────────────────────────────────────
say "数据库"
if [[ -z "${LARK_PG_DSN:-}" ]]; then
  cat <<'EOF'
  跳过 —— 没设 LARK_PG_DSN。
  群聊长期记忆需要 PostgreSQL（建议带 pgvector 扩展）。要启用：

    export LARK_PG_DSN=postgres://user:pass@127.0.0.1:5432/lark_agent
    psql "$LARK_PG_DSN" -f schema.sql
    ./install.sh          # 重跑，这步就会自动建表

  不配也能用，只是群聊没有长期记忆。
EOF
else
  if psql "$LARK_PG_DSN" -f schema.sql >/dev/null 2>&1; then
    ok "建表完成"
  else
    bad "建表失败，检查 LARK_PG_DSN 和 psql 是否可用"
  fi
fi

# ── Docker（容器模式）───────────────────────────────────────────────────
say "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "可用"
  echo "  构建 agent 镜像（几分钟）…"
  if (cd docker && docker build -q -t lark-claude-agent:latest . >/dev/null); then
    ok "镜像 lark-claude-agent:latest"
  else
    bad "镜像构建失败 —— 只影响容器模式，宿主机模式仍可用"
  fi
else
  echo "  跳过 —— 没有 docker，只能用宿主机模式（LARK_CONTAINER_MODE=false）"
fi

# ── systemd ─────────────────────────────────────────────────────────────
say "安装 systemd 模板"
UD="$HOME/.config/systemd/user"
mkdir -p "$UD"
for f in systemd/*.service; do
  sed "s|__INSTALL_DIR__|$HERE|g" "$f" > "$UD/$(basename "$f")"
  ok "$(basename "$f")"
done
systemctl --user daemon-reload
# 没有 linger 的话，退出登录服务就停了
loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q yes \
  || echo "  ⚠️  建议开启常驻：sudo loginctl enable-linger $USER"

cat <<EOF

$(printf '\033[1m装完了。下一步：\033[0m')

  1. 创建 bot（扫码，确认页务必选「智能体」）：
     .venv/bin/python register-app.py my-bot "描述" --slug mybot --users 你的邮箱

  2. 体检：
     ./doctor.sh mybot

  可选 —— 群聊语义检索需要向量化服务（要 GPU）：
     python3 -m venv .venv && .venv/bin/pip install sentence-transformers fastapi uvicorn
     systemctl --user enable --now lark-embed

  详见 README.md
EOF
