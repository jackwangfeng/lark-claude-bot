// 发图片到当前会话。
//
// 为什么做成插件而不是往容器里装命令：**SDK MCP server 跑在宿主机的桥接进程里**，
// 不在容器里（CLI 通过 stream-json 把工具调用回传给桥接执行）。所以：
//
//   · 加功能不用改 Dockerfile、不用重建容器、不用回填 CLAUDE.md
//   · 宿主机模式和容器模式自动一致，不会出现「jeff 能发图别人不能」
//   · 凭证留在宿主机，不用注入进容器
//
// 之前 larkimg 是装进镜像的二进制，改一次要动 5 个容器 —— 那是绕远路。
//
// ⚠️ 路径是 agent 视角的：容器模式下它看到的是 /workspace/x.png，
// 而桥接在宿主机上要读 ~/.lark-agent/containers/<slug>/workspace/x.png。
// 这个映射必须在这里翻译，搞反了就是「文件不存在」。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { sendImage } from '../lark.mts'
import type { PluginContext } from '../plugins.mts'

const CONTAINER_MODE = process.env.LARK_CONTAINER_MODE === 'true'
const MAX_BYTES = 10 * 1024 * 1024 // Lark 图片上限

/** agent 看到的路径 → 宿主机真实路径 */
function toHostPath(p: string, slug: string): string {
  if (!CONTAINER_MODE) return p
  const root = join(homedir(), '.lark-agent', 'containers', slug)
  if (p.startsWith('/workspace')) return join(root, 'workspace', p.slice('/workspace'.length))
  // 容器里的家目录也挂在宿主机上
  if (p.startsWith('/home/node/.claude')) return join(root, 'claude', p.slice('/home/node/.claude'.length))
  return p
}

export const scope = 'all'

export default (ctx: PluginContext) =>
  createSdkMcpServer({
    name: 'image',
    version: '1.0.0',
    tools: [
      tool(
        'send_image',
        '把一张本地图片发到当前 Lark 会话。生成了图表、截图、设计稿之后用这个发给用户 —— ' +
          '直接在回复里写 markdown 图片语法（![x](/workspace/a.png)）是没用的，Lark 渲染不了本地路径。',
        {
          path: z.string().describe('图片路径，用你自己看到的路径即可（如 /workspace/chart.png）'),
          caption: z.string().optional().describe('可选：图片前的一句说明'),
        },
        async ({ path, caption }) => {
          const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }] })
          if (!isAbsolute(path)) return fail('请用绝对路径')

          const hostPath = toHostPath(path, ctx.slug)
          let size: number
          try {
            const st = await stat(hostPath)
            if (!st.isFile()) return fail(`不是文件：${path}`)
            size = st.size
          } catch {
            return fail(`找不到文件：${path}`)
          }
          if (size > MAX_BYTES) {
            return fail(`图片 ${(size / 1048576).toFixed(1)}MB，超过 10MB 上限，先压缩再发`)
          }

          try {
            if (caption) await sendImage(ctx.chatId, hostPath, caption)
            else await sendImage(ctx.chatId, hostPath)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `已发送 ${path}（${Math.round(size / 1024)}KB）。图片已经在用户的聊天里了，回复里不用再贴路径。`,
                },
              ],
            }
          } catch (e) {
            return fail(`发送失败：${(e as Error).message}`)
          }
        },
      ),
    ],
  })
