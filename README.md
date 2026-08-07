# Lark ↔ Claude Code 桥接

在 Lark 里私聊或群 @ 机器人，背后跑的是本机的 Claude Code —— 手机上也能写代码、查资料、跑命令。

```
Lark 消息 ─┐
定时任务 ──┴→ 桥接（Node/TS）→ Claude Agent SDK → claude CLI（容器内或宿主机）
                   ↓                                      ↑
        PostgreSQL：群聊存档 / 向量 / 任务          插件：plugins/*.mts + mcp.json
```

## 能做什么

- **私聊 / 群 @** 都能用，各自独立会话
- **流式卡片**：回答边生成边刷新，工具调用可见
- **群聊长期记忆**：每条群消息实时落库 + 向量化，支持关键词 / 语义检索
- **收图收文件**：图片、文件、语音、视频下载到工作目录，agent 自己读（图片能直接看）
- **容器隔离**：每个 bot 一个 Docker 容器，碰不到宿主机（也可切宿主机模式自用）
- **Lark OpenAPI**：agent 能查群成员、搜云文档、读多维表格
- **定时任务**：「每天九点给我整理…」到点自动跑并推回会话
- **插件系统**：加功能改一个配置文件，不用动核心代码
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

⚠️ **扫码流程不能选租户**，它跟着你客户端/浏览器的当前登录会话走。名下有多个租户时，
应用会建到「当前那个」，而不是你想要的那个 —— 换域名、换链接都没用（`--intl` 只是
少绕一跳，同样不影响租户归属）。实测还遇到过退出登录后一直报「链接已失效」。

**多租户就别扫码了，直接后台建**，比想象的简单：

1. 登录目标租户的开放平台 → **创建「智能体」**
2. 事件订阅：方式选**长连接**（不是 webhook，这套没有公网回调地址），
   事件加 `im.message.receive_v1`
3. 创建版本并发布
4. 拿 App ID / Secret 走 `./new-bot.sh <slug> <app_id> <secret>`

**权限不用手动勾** —— 智能体类型自带这套 IM 能力。实测逐个验证过：
`im:chat.members:read`（查群成员）、`im:message.group_msg:readonly`（拉群历史）、
`contact:user.base:readonly`（查用户）、`im:message.reactions:write_only`（加表情）
全部开箱可用，收发消息更不用说。

所以扫码脚本的 `addons` 预置在这条路上意义不大，它主要省的是选类型之后的零星配置。

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

## 加功能：插件系统

**不用改核心代码。** 两条路，按需求选（详见 [plugins/README.md](plugins/README.md)）：

### A. 社区现成的 MCP → 改 `mcp.json`

天气、GitHub、Notion、Playwright、数据库…… 大多有人做好了：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "deny": ["delete_repository", "merge_pull_request"]
    }
  }
}
```

支持 `stdio` / `http` / `sse` 三种传输。额外字段：

| | |
|---|---|
| `scope` | `all`（默认）/ `group` 只群聊 / `dm` 只私聊 |
| `deny` | 禁止的工具名（不带 `mcp__<server>__` 前缀） |
| `disabled` | `true` 临时关掉 |

`${VAR}` 用桥接进程的同名环境变量替换 —— **密钥写在 `~/.lark-agent/<slug>/env`，
不要写进 `mcp.json`**（那个文件是要提交的）。

> ⚠️ stdio 类型的 server **由容器内的 CLI 启动**，`command` 必须在镜像里存在。
> 用 `npx` 每轮都要拉包（走代理很慢），常用的建议预装进 `docker/Dockerfile`。
> 远程 `http` 类型没这个问题，能用就优先用。

### B. 需要访问 PG / chatId → 加 `plugins/<name>.mts`

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { PluginContext } from '../plugins.mts'

export const scope = 'all'          // all | group | dm

export default (ctx: PluginContext) =>
  createSdkMcpServer({
    name: 'weather',
    version: '1.0.0',
    tools: [
      tool('get_weather', '查某地天气。写清楚「什么时候该用」，模型才会主动选它。',
        { city: z.string() },
        async ({ city }) => ({ content: [{ type: 'text' as const, text: `${city}：晴` }] })),
    ],
  })
```

文件名即 server 名 → 工具全名 `mcp__weather__get_weather`。
单个插件抛异常只跳过它，不影响其他插件和主流程。

现有的三个：`plugins/schedule.mts`（定时任务）、`plugins/chatlog.mts`（群聊检索）、
`mcp.json` 里的 `lark`（群成员 / 云文档 / 多维表格）。

**改完都要 `systemctl --user restart lark-claude@<slug>`** —— 插件在 `run()` 时加载，
但 Node 的 import 有缓存，同进程内改文件不会重新读。

## 定时任务

用户说「每天九点给我…」时，agent 会调 `create_scheduled_task` 登记到 PG，
桥接每分钟扫一次，到点主动跑一轮并把结果推回会话。

```
create_scheduled_task    登记（cron 五段式，服务器本地时区）
list_scheduled_tasks     查看，含上次执行时间和结果
delete_scheduled_task    删除
toggle_scheduled_task    暂停 / 恢复
```

**没用 SDK 自带的 `CronCreate`** —— 那是会话级的，唤醒的是发起它的 SDK 会话；
而这里一条消息一个进程，cron 醒来时会话早没了，agent 也不知道该发到哪个 chat。

定时任务无人值守，所以**一律拒绝工具审批**（`approve: () => false`），
不会停在那儿等 y/n；agent 会换个办法或说明做不了。

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

## 私聊为什么不入库

**只有群消息落 PG，私聊不落。** 不是漏了 —— 私聊的历史 Claude Code 自己就存了：

```
~/.lark-agent/<slug>/…/claude/projects/-workspace/<session-id>.jsonl
  ↔ 容器内 /home/node/.claude/projects/…      agent 能直接 rg
```

而且比 PG 存的更全：**连 bot 自己的回复都在**（入库的只有用户发的消息）。
再存一份是重复，还把私聊内容放进了共享库 —— 给同事用的 bot 尤其不合适。

代价是私聊只能关键词 grep，没有语义检索；`/new` 之后也要 agent 自己去翻文件。
需要的话设 `ARCHIVE_DM=true`，私聊就照群聊那套入库 + 向量化，
`mcp__chatlog__*` 也会对私聊开放。那时存档放在鉴权**之后** —— 和群聊相反，
群里所有人的发言都是上下文，但私聊里未授权的人不该在库里留记录。

## 收图收文件

图片、文件、语音、视频会下载到工作目录的 `uploads/`，把路径写进 prompt 交给 agent，
它自己决定怎么读（图片直接 `Read`，文档按后缀处理）。富文本里内嵌的图也会一并抠出来。

**连发的多个附件会合并成一轮。** Lark 是「一张图一条消息」，发 3 张就是 3 个事件 ——
不合并会触发 3 轮 Claude：又慢又贵，而且模型每轮只看得到一张，没法对比着说。
纯附件消息先攒 `ATTACH_DEBOUNCE_MS`（默认 2.5 秒），期间补了文字就立刻连附件一起发。
纯文字消息不受影响，**不会为此多等** 2.5 秒。

判断逻辑抽在 `attach.mts` 的 `planAttach()` 里，`node test-attach.mts` 可跑单测 ——
分支容易想漏，尤其「先发几张图、再打一句话」那条：那句话本身不带附件，
但必须把攒着的图一起带走。

⚠️ 容器模式下**写的是宿主机路径、给 agent 的是容器内路径**
（`~/.lark-agent/<slug>/…/workspace/uploads` ↔ `/workspace/uploads`）——
搞反了 agent 会报文件不存在。文件名带 `message_id` 前缀，避免同名互相覆盖。

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
| `LARK_WS_PING_TIMEOUT` | `30` | 秒。发完 ping 多久没有任何入站帧就判定掉线 |
| `LARK_WS_HANDSHAKE_TIMEOUT_MS` | `20000` | 握手超时（代理/NAT 下可能永远挂着） |
| `LARK_SEEN_TTL_MS` | `7200000` | 消息去重窗口，必须大于 Lark 最长补投间隔 |
| `GROUP_CONTEXT_N` | `10` | 群聊每轮自动带上的最近几条，见下 |
| `ARCHIVE_DM` | `false` | 私聊也入库 + 向量化，见下 |
| `ATTACH_DEBOUNCE_MS` | `2500` | 连发的附件攒多久合成一轮 |

## 群聊上下文：塞多少 vs 让它自己搜

每轮自动带上最近 `GROUP_CONTEXT_N` 条（默认 10），只保证「接得上话」。
更早的**不塞**，让 agent 用 `mcp__chatlog__*` 按需检索（关键词 / 语义 / 取更多最近的）。

这么分是因为固定窗口两头不讨好：塞多了每条群消息都烧 token，塞少了又接不上；
而「要翻多久以前」本来就该由模型判断 —— 它有全量历史的检索工具，比一个写死的数字准。
群里话题密集、经常要联系上文的，把这个值调大即可。

## 掉线与补拉

长连接会**静默掉线** —— 服务端不发 close，只能等 TCP 报错，实测从掉线到发现最长过了
18 分钟。这期间 Lark 推不过来的事件不会丢，但补投走它自己的退避时钟（实测 ~5 分钟、
~65 分钟两档），也**不会因为客户端重连就立刻冲刷队列**。用户看到的就是「发了消息半天
不理，过一会儿突然回了」。

两层处理：

- **`pingTimeout` 看门狗** 把「发现掉线」压到 ping 间隔（服务端下发，120s）+ 30s 以内，
  掉线窗口从十几分钟缩到 ≤150 秒 —— 落进窗口的消息本身就变少了
- **重连后主动补拉**（`fetchMissedEvents`）把窗口内的消息捞回来喂进正常流程，
  不用干等 Lark 的退避时钟

补拉靠 `message_id` 去重，重复拉是安全的；起点同时受两个下界钳制:
去重窗口（超出会重复回复）和**进程启动时间**（重启后去重表是空的，
更早的消息可能已被上一个进程回过）。

日志里认这几行：`[ws] 掉线` / `[ws] 已重连` / `[补拉] 完成，扫了 N 个会话…追回 M 条`。

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
| `db.mts` | PG：群聊存档、关键词 / 语义检索、定时任务 |
| `plugins.mts` / `plugins/` | 插件加载与自研工具 |
| `mcp.json` | 外部 MCP 配置（社区现成的） |
| `scheduler.mts` / `schedule-mcp.mts` | 定时任务：调度器 + 登记工具 |
| `chatlog-mcp.mts` | 给 agent 的「查群聊记录」工具 |
| `embed*.mts` / `embed-server.py` | 向量化 |
| `register-app.py` | 扫码建应用 |
| `new-bot.sh` / `doctor.sh` | 建实例 / 体检 |
| `whois.mts` / `grant-visibility.mts` / `disable-app.mts` | 管理工具 |
