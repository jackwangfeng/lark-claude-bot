// 会话历史检索（关键词 + 语义）。
//
// 私聊默认不挂载 —— 上下文本来就在 Claude Code 的会话里，而且是落盘的
// （~/.claude/projects/**/*.jsonl，容器里 agent 能直接 rg，连自己的回复都在）。
// 再入一份 PG 是重复存储，还把私聊内容放进了共享库。
// 只有开 ARCHIVE_DM=true 才对私聊开放。
import { chatlogServer } from '../chatlog-mcp.mts'
import type { PluginContext } from '../plugins.mts'

const ARCHIVE_DM = process.env.ARCHIVE_DM === 'true'

export const scope = 'all'
export default (ctx: PluginContext) =>
  ctx.isGroup || ARCHIVE_DM ? chatlogServer(ctx.chatId) : null
