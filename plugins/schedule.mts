// 定时任务。私聊和群聊都要 —— 「每天九点给我…」两边都会说。
import { scheduleServer } from '../schedule-mcp.mts'
import type { PluginContext } from '../plugins.mts'

export const scope = 'all'
export default (ctx: PluginContext) => scheduleServer(ctx.chatId, ctx.slug)
