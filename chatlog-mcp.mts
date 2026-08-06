// 给 agent 的「查群聊记录」工具（SDK 内置 MCP server，不起额外进程）。
//
// 比让它 grep 文件好在：不用把原始聊天记录塞进容器文件系统，
// 查询走 PG 索引，而且能按发言人/时间范围过滤。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { recentMessages, searchMessages, semanticSearch, type StoredMessage } from './db.mts'
import { embedOne } from './embed.mts'

const fmt = (rows: StoredMessage[]): string => {
  if (!rows.length) return '没有匹配的记录。'
  return rows
    .map((m) => {
      const t = new Date(m.sentAt).toISOString().slice(0, 16).replace('T', ' ')
      return `[${t}] ${m.senderName || m.senderId.slice(-4)}: ${m.content}`
    })
    .join('\n')
}

/** chatId 由桥接注入 —— agent 只能查它所在的这个会话，不能翻别的群 */
export function chatlogServer(chatId: string) {
  return createSdkMcpServer({
    name: 'chatlog',
    version: '1.0.0',
    tools: [
      tool(
        'search_chat_history',
        '在本会话的历史聊天记录里按关键词检索。用于回忆很久以前说过的事。',
        {
          keyword: z.string().describe('关键词，支持中文，按子串匹配'),
          limit: z.number().int().min(1).max(100).default(30).describe('最多返回多少条'),
        },
        async ({ keyword, limit }) => ({
          content: [{ type: 'text', text: fmt(await searchMessages(chatId, keyword, limit)) }],
        }),
      ),
      tool(
        'semantic_search_chat_history',
        '在本会话历史里按「意思」检索，不需要词面命中。' +
          '适合「大家之前讨论过哪些跟成本有关的事」这类模糊问题；' +
          '要找确定的词（人名、产品名、报错），用 search_chat_history 更准。',
        {
          query: z.string().describe('一句自然语言描述你想找什么'),
          limit: z.number().int().min(1).max(50).default(20).describe('最多返回多少条'),
        },
        async ({ query, limit }) => {
          try {
            const rows = await semanticSearch(chatId, await embedOne(query), limit)
            if (!rows.length) return { content: [{ type: 'text' as const, text: '没有匹配的记录。' }] }
            const text = rows
              .map((m) => {
                const t = new Date(m.sentAt).toISOString().slice(0, 16).replace('T', ' ')
                // 余弦距离越小越像，给模型一个判断依据
                return `[${t}] (相似度 ${(1 - m.distance).toFixed(2)}) ${m.senderName || m.senderId.slice(-4)}: ${m.content}`
              })
              .join('\n')
            return { content: [{ type: 'text' as const, text }] }
          } catch (e) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `语义检索不可用（${(e as Error).message}）。改用 search_chat_history 按关键词找。`,
                },
              ],
            }
          }
        },
      ),
      tool(
        'recent_chat_history',
        '取本会话最近的聊天记录（时间正序）。用于了解最近发生了什么。',
        {
          limit: z.number().int().min(1).max(200).default(50).describe('取最近多少条'),
        },
        async ({ limit }) => ({
          content: [{ type: 'text', text: fmt(await recentMessages(chatId, limit)) }],
        }),
      ),
    ],
  })
}
