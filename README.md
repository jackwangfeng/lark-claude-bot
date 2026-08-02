# Lark ↔ Claude Code 桥接

在 Lark 里私聊或群 @ 机器人，背后跑的是本机的 Claude Code —— 手机上也能写代码、查资料、跑命令。

```
Lark 消息 → 桥接（Node/TS）→ Claude Agent SDK → claude CLI（容器内或宿主机）
                ↓
          PostgreSQL：群聊存档 + 向量检索
```

## 能做什么

- **私聊 / 群 @** 都能用，各自独立会话
- **流式卡片**：回答边生成边刷新，工具调用可见
- **群聊长期记忆**：每条群消息实时落库，支持关键词 + 语义两种检索
- **容器隔离**：每个 bot 一个 Docker 容器，碰不到宿主机（也可切宿主机模式自用）
- **Lark OpenAPI**：agent 能查群成员、搜云文档、读多维表格
- **斜杠命令**：`/new` `/cd` `/stop` `/status` `/yolo`；其余转给 Claude Code（`/usage` `/context` `/compact` …）

## 环境要求

| | 必需 | 说明 |
|---|---|---|
| Node | ✅ **≥ 22.18** | 直接跑 `.mts`，不需要构建。低版本会报 `Unknown file extension ".mts"` |
| Claude Code | ✅ | 已登录（`claude` 命令可用） |
| Docker | 建议 | 容器模式要；不装只能宿主机模式 |
| PostgreSQL | 可选 | 群聊长期记忆要；建议装 pgvector |
| GPU | 可选 | 语义检索要（bge-m3） |

## 安装

```bash
git clone <repo> lark && cd lark
export LARK_PG_DSN=postgres://user:pass@127.0.0.1:5432/lark_agent   # 可选
./install.sh
```

装依赖 → 类型检查 → 建表 → 构建镜像 → 装 systemd 模板。

## 创建一个 bot

```bash
.venv/bin/python register-app.py my-bot "我的助手" --slug mybot --users 同事@corp.com
./doctor.sh mybot
```

会打印扫码链接。**确认页必须选「智能体」** —— 选「机器人」的话私聊输入框根本不可用，
权限配全了也没用（实测踩过）。

扫完自动完成：邮箱转 union_id → 写凭证 → 加应用可用范围 → 注册 systemd → 启动验活。
后台不用点，权限已通过 `addons` 预置。

细节和排错见 [SETUP.md](SETUP.md)。

## 语义检索（可选）

需要 GPU。

```bash
python3 -m venv .venv
.venv/bin/pip install sentence-transformers fastapi 'uvicorn[standard]'
HF_ENDPOINT=https://hf-mirror.com .venv/bin/python -c \
  "from huggingface_hub import snapshot_download; snapshot_download('BAAI/bge-m3')"
systemctl --user enable --now lark-embed
```

群消息落库后由后台 worker 15 秒一轮批量补向量。**服务没起也不影响收发消息** ——
只是暂时搜不到语义相似的内容，起来后会自动补上。

## 日常运维

```bash
systemctl --user list-units 'lark-claude@*'       # 所有实例
systemctl --user restart lark-claude@mybot        # 改完代码重启（所有实例共用代码）
journalctl --user -u lark-claude@mybot -f         # 跟日志
./doctor.sh mybot                                 # 体检：凭证 / 权限 / 长连接 / 可用范围
npx tsc --noEmit                                  # 类型检查
```

每个实例的数据：

```
~/.lark-agent/<slug>/
  env            凭证 + 每机配置（600 权限，不在仓库里）
  users.json     私聊白名单（热加载，改完即生效）
  sessions.json  会话表
~/.lark-agent/containers/<slug>/{workspace,claude}   容器模式的工作区
```

## 两种运行模式

| | 容器（默认） | 宿主机 |
|---|---|---|
| 用途 | 给别人用 | 自己用，要控制这台机器 |
| 隔离 | 碰不到宿主机文件 | 无隔离 |
| 开启 | 默认 | drop-in 里设 `LARK_CONTAINER_MODE=false` |

⚠️ **宿主机模式下，能私聊这个 bot 的人就能在这台机器上执行命令**（免审批时尤其如此）。
所以这种实例的 `users.json` 只放自己，并且**不要拉进群** ——
群聊规则是「谁 @ 都服务」，不看白名单。给别人用的 bot 一律走容器模式。

## 授权模型

- **私聊** —— 只有 `users.json` 里的人（用 `union_id`，`on_` 开头）
- **群聊** —— 群里任何人 @ 都响应；**所有人的发言都会存档**（存储和回应是两件事）

`open_id` 按应用隔离，同一个人在不同 bot 下 ID 不同 —— 白名单一律用 `union_id`。

## 配置项

写在 `~/.lark-agent/<slug>/env`：

```bash
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_PG_DSN=postgres://...          # 不配则无长期记忆
HTTPS_PROXY=http://127.0.0.1:7890   # 要代理才能访问 api.anthropic.com 的话
NO_PROXY=localhost,127.0.0.1
```

systemd 模板里的（改 unit 或加 drop-in）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LARK_CONTAINER_MODE` | `true` | 容器 / 宿主机 |
| `DEFAULT_YOLO` | `true` | 新会话免工具审批 |
| `TURN_IDLE_TIMEOUT_MS` | `300000` | 多久没进展就中断（网络挂死兜底） |
| `TURN_MAX_MS` | `1800000` | 单轮硬上限 |
| `LARK_LOOKUP_SLUG` | `admin` | 「管理实例」，见下 |

## 管理实例

跨应用的能力集中放在一个实例上，其他 bot 借用，不用每个都配：

```
contact:user.id:readonly   邮箱/手机 → union_id（new-bot.sh 填邮箱要它）
admin:app.visibility       改任意应用的可用范围
admin:app.info:readonly    查应用信息
admin:app.enable:write     停用/启用应用（disable-app.mts）
```

用 `LARK_LOOKUP_SLUG` 指定是哪个实例。

## 文件

| | |
|---|---|
| `index.mts` | 收消息、鉴权、去重、命令、排队 |
| `agent.mts` | Agent SDK 封装：会话续接、超时、审批、MCP |
| `lark.mts` | Lark API：发消息、流式卡片、拉历史 |
| `db.mts` | PG：存档、关键词 / 语义检索 |
| `chatlog-mcp.mts` | 给 agent 的「查群聊记录」工具 |
| `embed*.mts` / `embed-server.py` | 向量化 |
| `register-app.py` | 扫码建应用 |
| `new-bot.sh` / `doctor.sh` | 建实例 / 体检 |
| `whois.mts` / `grant-visibility.mts` / `disable-app.mts` | 管理工具 |
