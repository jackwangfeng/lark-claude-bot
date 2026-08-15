// Lark 云文档读写。
//
// 为什么不直接放开 mcp.json 里的 lark MCP：那个是 preset.default，20+ 个工具，
// 每轮都要付工具定义的 token，而且它 scope=group，私聊用不了。这里只做三件
// 真正常用的事，私聊群聊都能用。
//
// 写文档走 markdown：docx.document.convert 直接吃 markdown 转成文档块，
// agent 本来就产出 markdown，不用手拼 block 结构。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { client } from '../lark.mts'
import type { PluginContext } from '../plugins.mts'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** 从各种形态的链接/输入里抠出 document_id */
function docIdOf(input: string): string {
  const s = input.trim()
  // https://xxx.larksuite.com/docx/<id>?from=...  或  /wiki/<id>
  const m = s.match(/\/(?:docx|wiki|docs)\/([A-Za-z0-9]+)/)
  if (m) return m[1]!
  // 已经是裸 id
  return s.replace(/^https?:\/\/\S+\//, '').split('?')[0]!
}

export const scope = 'all'

export default (_ctx: PluginContext) =>
  createSdkMcpServer({
    name: 'doc',
    version: '1.0.0',
    tools: [
      tool(
        'read_doc',
        '读一篇 Lark 云文档的全文（纯文本）。用户发来文档链接、或者让你「看看这篇文档」' +
          '「总结一下这个文档」时用。传链接或 document_id 都行。',
        {
          doc: z.string().describe('文档链接或 document_id'),
        },
        async ({ doc }) => {
          const id = docIdOf(doc)
          try {
            const r: any = await client.docx.document.rawContent({ path: { document_id: id } })
            const content = r?.data?.content ?? r?.content
            if (!content) return text(`读到空内容，确认这个文档存在且机器人有权限：${id}`)
            return text(content)
          } catch (e) {
            const msg = (e as any)?.response?.data?.msg ?? (e as Error).message
            // 最常见的失败不是"读不了"，是"没被邀请"，说清楚省得 agent 反复重试
            return text(
              `读取失败：${msg}\n\n` +
                '如果是权限问题，让用户在文档右上角「分享」里把这个机器人加为协作者' +
                '（搜机器人名字即可），或者把文档设为「组织内可阅读」。',
            )
          }
        },
      ),
      tool(
        'create_doc',
        '新建一篇 Lark 云文档，内容用 markdown 写。' +
          '适合输出长内容 —— 报告、方案、会议纪要、整理好的资料。' +
          '比把几千字堆在聊天里强：用户能收藏、能编辑、能转发给别人。' +
          '返回文档链接，**拿到后要把链接发给用户**。',
        {
          title: z.string().describe('文档标题'),
          markdown: z.string().describe('正文，标准 markdown（标题/列表/表格/代码块都支持）'),
        },
        async ({ title, markdown }) => {
          try {
            const c: any = await client.docx.document.create({ data: { title } })
            const id = c?.data?.document?.document_id ?? c?.document?.document_id
            if (!id) return text('建文档失败：没拿到 document_id')

            // markdown → 文档块
            const conv: any = await client.docx.document.convert({
              data: { content_type: 'markdown', content: markdown },
            })
            const blocks = conv?.data?.blocks ?? conv?.blocks ?? []
            const firstLevel: string[] = conv?.data?.first_level_block_ids ?? conv?.first_level_block_ids ?? []

            if (blocks.length) {
              await client.docx.documentBlockChildren.create({
                path: { document_id: id, block_id: id },
                data: {
                  children: blocks.filter((b: any) => firstLevel.includes(b.block_id)),
                  index: 0,
                },
                params: { document_revision_id: -1 },
              } as any)
            }

            const url = `https://open.larksuite.com/docx/${id}`
            return text(
              `已创建文档「${title}」\n${url}\n\n` +
                '把这个链接发给用户。注意：新建的文档只有机器人自己能看，' +
                '用户要访问的话，你得告诉他们你没法自动授权 —— ' +
                '这一点如果成为问题，让用户反馈给管理员。',
            )
          } catch (e) {
            const msg = (e as any)?.response?.data?.msg ?? (e as Error).message
            // 智能体自带的是 docx:document:write_only（能往已有文档写），
            // 但**新建**要 docx:document:create，那个得后台手动勾。
            // 直接把这句说清楚，省得 agent 反复重试或者瞎猜。
            if (/scope/i.test(String(msg))) {
              return text(
                '这个机器人还没有「新建文档」的权限。\n\n' +
                  '告诉用户：去开放平台后台 → 该应用 → 权限管理 → 勾上 ' +
                  '`docx:document:create` → 创建版本并发布，之后就能用了。\n\n' +
                  '在那之前，可以改用 append_doc 往用户已有的文档里写，' +
                  '或者直接把内容发在聊天里 / 用 send_file 发成文件。',
              )
            }
            return text(`创建失败：${msg}`)
          }
        },
      ),
      tool(
        'append_doc',
        '往已有的 Lark 文档末尾追加内容（markdown）。' +
          '适合往同一篇文档里持续累积 —— 比如日报、跟进记录。',
        {
          doc: z.string().describe('文档链接或 document_id'),
          markdown: z.string().describe('要追加的内容，markdown'),
        },
        async ({ doc, markdown }) => {
          const id = docIdOf(doc)
          try {
            const conv: any = await client.docx.document.convert({
              data: { content_type: 'markdown', content: markdown },
            })
            const blocks = conv?.data?.blocks ?? conv?.blocks ?? []
            const firstLevel: string[] = conv?.data?.first_level_block_ids ?? conv?.first_level_block_ids ?? []
            if (!blocks.length) return text('转换后没有内容可追加')

            await client.docx.documentBlockChildren.create({
              path: { document_id: id, block_id: id },
              data: { children: blocks.filter((b: any) => firstLevel.includes(b.block_id)) },
              params: { document_revision_id: -1 },
            } as any)
            return text(`已追加到文档 ${id}`)
          } catch (e) {
            const msg = (e as any)?.response?.data?.msg ?? (e as Error).message
            return text(`追加失败：${msg}\n\n权限问题的话，让用户把机器人加为文档协作者。`)
          }
        },
      ),
    ],
  })
