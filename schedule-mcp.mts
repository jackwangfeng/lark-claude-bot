// 让 agent 能登记定时任务。
//
// agent 只负责把用户的口头指令（「每天九点整理新闻」）转成一条记录，
// 真正的调度和推送由桥接的 scheduler 做 —— SDK 自带的 CronCreate 是会话级的，
// 在这个「一条消息一个进程」的架构里醒来时会话已经没了。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createTask, listTasks, deleteTask, setTaskEnabled } from './db.mts'
import { validateCron } from './scheduler.mts'

export function scheduleServer(chatId: string, botSlug: string, createdBy?: string) {
  return createSdkMcpServer({
    name: 'schedule',
    version: '1.0.0',
    tools: [
      tool(
        'create_scheduled_task',
        '登记一个定时任务，到点后自动执行并把结果发到本会话。' +
          '用户说「每天九点给我…」「每周一提醒我…」这类需求时用它。',
        {
          title: z.string().describe('任务名，给人看的，如「每日 AI 与金融新闻」'),
          prompt: z
            .string()
            .describe(
              '到点后交给你自己执行的完整指令。要写成独立可执行的样子 —— ' +
                '执行时是全新会话，看不到现在的上下文。',
            ),
          cron: z
            .string()
            .describe('五段式 cron（分 时 日 月 周），服务器本地时区。每天 9:00 = "0 9 * * *"'),
        },
        async ({ title, prompt, cron }) => {
          const bad = validateCron(cron)
          if (bad) return { content: [{ type: 'text' as const, text: `cron 格式错误：${bad}` }] }
          try {
            const id = await createTask({ chatId, botSlug, createdBy, title, prompt, cron })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `已登记任务 #${id}「${title}」，cron = ${cron}（服务器本地时区）。到点会自动执行并把结果发到这个会话。`,
                },
              ],
            }
          } catch (e) {
            return {
              content: [
                { type: 'text' as const, text: `登记失败：${(e as Error).message}。可能是数据库不可用。` },
              ],
            }
          }
        },
      ),
      tool(
        'list_scheduled_tasks',
        '列出本会话已登记的定时任务，含上次执行时间和结果。',
        {},
        async () => {
          const rows = await listTasks(chatId)
          if (!rows.length) return { content: [{ type: 'text' as const, text: '还没有定时任务。' }] }
          const text = rows
            .map((t) => {
              const last = t.lastRunAt
                ? `上次 ${new Date(t.lastRunAt).toLocaleString('zh-CN')} ${t.lastStatus}`
                : '还没执行过'
              return `#${t.id} ${t.enabled ? '✅' : '⏸'} ${t.title}\n   cron: ${t.cron}\n   ${last}${
                t.lastError ? `\n   错误: ${t.lastError}` : ''
              }`
            })
            .join('\n')
          return { content: [{ type: 'text' as const, text }] }
        },
      ),
      tool(
        'delete_scheduled_task',
        '删除一个定时任务。先用 list_scheduled_tasks 拿到 id。',
        { id: z.number().int().describe('任务 id') },
        async ({ id }) => ({
          content: [
            {
              type: 'text' as const,
              text: (await deleteTask(chatId, id)) ? `已删除任务 #${id}` : `没找到任务 #${id}`,
            },
          ],
        }),
      ),
      tool(
        'toggle_scheduled_task',
        '暂停或恢复一个定时任务（不删除）。',
        {
          id: z.number().int().describe('任务 id'),
          enabled: z.boolean().describe('true 恢复，false 暂停'),
        },
        async ({ id, enabled }) => ({
          content: [
            {
              type: 'text' as const,
              text: (await setTaskEnabled(chatId, id, enabled))
                ? `任务 #${id} 已${enabled ? '恢复' : '暂停'}`
                : `没找到任务 #${id}`,
            },
          ],
        }),
      ),
    ],
  })
}
