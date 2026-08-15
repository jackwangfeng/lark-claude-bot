// 把本地文件 / 图片发给用户。
//
// 做成插件而不是往容器里装命令：SDK MCP server 跑在宿主机的桥接进程里，
// 加功能不用改 Dockerfile、不用重建容器，宿主机模式和容器模式也自动一致。
//
// ⚠️ 路径要翻译。插件在宿主机执行，但 agent 给的是它自己看到的路径：
//   容器模式  /workspace/x.png → ~/.lark-agent/containers/<slug>/workspace/x.png
// 搞反了就是「文件不存在」，而且报错看起来像 agent 的锅。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { basename, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { sendImage, sendFile } from '../lark.mts'
import type { PluginContext } from '../plugins.mts'

const CONTAINER_MODE = process.env.LARK_CONTAINER_MODE === 'true'
const MAX_IMAGE = 10 * 1024 * 1024 // Lark 图片上限
const MAX_FILE = 30 * 1024 * 1024 // 文件上限

/** agent 看到的路径 → 宿主机真实路径 */
function toHostPath(p: string, slug: string): string {
  if (!CONTAINER_MODE) return p
  const root = join(homedir(), '.lark-agent', 'containers', slug)
  if (p.startsWith('/workspace')) return join(root, 'workspace', p.slice('/workspace'.length))
  if (p.startsWith('/home/node/.claude'))
    return join(root, 'claude', p.slice('/home/node/.claude'.length))
  return p
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** 共用的前置检查：路径合法、文件存在、大小没超 */
async function check(path: string, slug: string, max: number) {
  if (!isAbsolute(path)) return { err: '请用绝对路径' }
  const hostPath = toHostPath(path, slug)
  try {
    const st = await stat(hostPath)
    if (!st.isFile()) return { err: `不是文件：${path}` }
    if (st.size > max)
      return { err: `${(st.size / 1048576).toFixed(1)}MB，超过 ${max / 1048576}MB 上限` }
    return { hostPath, size: st.size }
  } catch {
    return { err: `找不到文件：${path}` }
  }
}

export const scope = 'all'

export default (ctx: PluginContext) =>
  createSdkMcpServer({
    name: 'send',
    version: '1.0.0',
    tools: [
      tool(
        'send_image',
        '把一张本地图片发到当前 Lark 会话，用户会看到图片本身。' +
          '生成了图表、截图、设计稿之后用这个 —— 在回复里写 markdown 图片语法' +
          '（![x](/workspace/a.png)）是没用的，Lark 渲染不了本地路径。',
        {
          path: z.string().describe('图片路径，用你自己看到的路径（如 /workspace/chart.png）'),
          caption: z.string().optional().describe('可选：图片前的一句说明'),
        },
        async ({ path, caption }) => {
          const r = await check(path, ctx.slug, MAX_IMAGE)
          if ('err' in r) return text(r.err!)
          try {
            await sendImage(ctx.chatId, r.hostPath!, caption)
            return text(
              `已发送图片 ${path}（${Math.round(r.size! / 1024)}KB）。用户已经看到了，回复里不用再贴路径。`,
            )
          } catch (e) {
            return text(`发送失败：${(e as Error).message}`)
          }
        },
      ),
      tool(
        'send_file',
        '把一个本地文件发到当前 Lark 会话，用户可以下载。' +
          '适合数据文件、文档、压缩包、日志 —— 内容长但用户需要留存的东西，' +
          '比堆在聊天里强。图片用 send_image（那个会直接显示出来）。',
        {
          path: z.string().describe('文件路径，用你自己看到的路径（如 /workspace/data.csv）'),
          file_name: z
            .string()
            .optional()
            .describe('可选：用户看到的文件名，不填就用原文件名'),
          caption: z.string().optional().describe('可选：文件前的一句说明'),
        },
        async ({ path, file_name, caption }) => {
          const r = await check(path, ctx.slug, MAX_FILE)
          if ('err' in r) return text(r.err!)
          const name = file_name?.trim() || basename(path)
          try {
            await sendFile(ctx.chatId, r.hostPath!, name, caption)
            return text(
              `已发送文件 ${name}（${(r.size! / 1048576).toFixed(2)}MB）。用户可以直接下载。`,
            )
          } catch (e) {
            return text(`发送失败：${(e as Error).message}`)
          }
        },
      ),
    ],
  })
