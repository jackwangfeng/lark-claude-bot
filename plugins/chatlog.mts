// 群聊历史检索（关键词 + 语义）。私聊的上下文本来就在会话里，不需要。
import { chatlogServer } from '../chatlog-mcp.mts'
import type { PluginContext } from '../plugins.mts'

export const scope = 'all'
export default (ctx: PluginContext) => chatlogServer(ctx.chatId)
