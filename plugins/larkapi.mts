// Lark OpenAPI 兜底通道：没有现成 MCP 工具时，让 agent 自己查文档、自己调。
//
// 为什么给这个能力：Lark 的 API 有上千个，不可能每个都包一层。而且 agent
// **本来就能** curl —— claude-exec.sh 每轮把 LARK_APP_SECRET 注进容器（给 lark-mcp 用），
// 它自己拼个 token 就能调任意接口。所以这不是放权，是把已有的能力做得可用、可控：
//
//   · 不用手拼 tenant_access_token
//   · 错误按 Lark 的格式解析好（含缺权限时的后台直达链接）
//   · 有 deny 名单 —— 裸 curl 是一点护栏都没有的
//
// ⚠️ 优先级：先用专门的 MCP 工具（schedule / chatlog / doc / send / lark），
// 都没有再用这个。专门工具的描述里写了「什么时候该用」，模型选得准；
// 而这个通道要它自己拼路径，容易出错。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { client } from '../lark.mts'
import type { PluginContext } from '../plugins.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SDK_TYPES = join(HERE, '..', 'node_modules', '@larksuiteoapi', 'node-sdk', 'types', 'index.d.ts')

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

interface ApiEntry { project: string; version: string; resource: string; apiName: string }
let apiCache: ApiEntry[] | null = null

/**
 * 从 SDK 类型文件里扒出接口清单。
 *
 * 类型文件里**没有真实 URL 路径**，只有 api-explorer 的 query
 * （project / resource / apiName / version）—— 但那正好对应 SDK 的方法名
 * `client.<project>.<resource>.<apiName>()`，比拼 URL 可靠。实测能解析出 1631 个。
 */
async function loadApiIndex(): Promise<ApiEntry[]> {
  if (apiCache) return apiCache
  try {
    const types = await readFile(SDK_TYPES, 'utf8')
    const seen = new Map<string, ApiEntry>()
    for (const m of types.matchAll(/api-explorer\?([^\s"']+)/g)) {
      const q = Object.fromEntries(
        m[1]!.split('&').filter((x) => x.includes('=')).map((x) => x.split('=', 2) as [string, string]),
      )
      if (!q.project || !q.resource || !q.apiName || !q.version) continue
      const key = `${q.project}.${q.version}.${q.resource}.${q.apiName}`
      if (!seen.has(key)) seen.set(key, { project: q.project, version: q.version, resource: q.resource, apiName: q.apiName })
    }
    apiCache = [...seen.values()].sort((a, b) =>
      `${a.project}${a.resource}${a.apiName}`.localeCompare(`${b.project}${b.resource}${b.apiName}`),
    )
  } catch {
    apiCache = []
  }
  return apiCache
}

/**
 * 禁止的接口。理由分两类：
 *
 *   会绕过桥接的机制 —— 直接发消息就跳过了流式卡片、去重、排队那一套，
 *   而且用的是 bot 身份，用户会看到两条来源不明的消息
 *   不可逆或影响他人 —— 删文档、改权限、踢人
 *
 * 注意这只是减速带：agent 有 Bash，真想绕开可以自己 curl（凭证就在容器里）。
 * 拦的是「顺手做了没想清楚」，不是恶意。
 */
const DENY: Array<[RegExp, string]> = [
  [/^\/open-apis\/im\/v1\/messages\b.*$/, '发消息请直接回复用户，或用 mcp__send__*；直接调这个会绕过流式卡片'],
  [/\/(delete|remove)\b/i, '删除类操作请先跟用户确认，确认后让用户自己在界面上做'],
  [
    /^\/open-apis\/drive\/v1\/permissions\//,
    '改文档权限影响他人。给自己新建的文档授权用 mcp__doc__create_doc（它会自动做），' +
      '给别人的文档改权限请让用户自己在「分享」里操作',
  ],
  [/^\/open-apis\/im\/v1\/chats\/[^/]+\/members\b/, '增删群成员影响他人，让用户自己操作'],
  [/^\/open-apis\/application\/v6\/applications\/[^/]+\/(contacts_range|visibility)/, '改应用可用范围要管理员来'],
]

/**
 * 走 SDK 方法名时的 deny。和路径那份是同一套语义，只是匹配对象不同 ——
 * 两条路都要拦，不然 agent 换个入口就绕过去了。
 */
const DENY_SDK: Array<[RegExp, string]> = [
  [/^im\.message\.(create|reply|update|patch|delete)$/, '发消息请直接回复用户，或用 mcp__send__*；直接调会绕过流式卡片'],
  [/\.(delete|remove|batchDelete)$/i, '删除类操作先跟用户确认，让他自己在界面上做'],
  [
    /^drive\.permission/,
    '改文档权限影响他人。给自己新建的文档授权用 mcp__doc__create_doc（它会自动做），' +
      '给别人的文档改权限请让用户自己在「分享」里操作',
  ],
  [/^im\.chatMembers\.(create|delete)$/, '增删群成员影响他人，让用户自己操作'],
  [/^application\..*(visibility|contactsRange)/i, '改应用可用范围要管理员来'],
]

function denyBySdkName(name: string): string {
  for (const [re, why] of DENY_SDK) if (re.test(name)) return why
  return ''
}

/** 把 Lark 的报错翻成能照做的话 —— 缺权限时它自带后台直达链接，那个最有用 */
function explainError(e: unknown): string {
  const d = (e as any)?.response?.data
  if (!d) return `调用失败：${(e as Error).message}`
  const help = d?.error?.helps?.[0]?.url
  return (
    `调用失败 code=${d.code}：${d.msg}` +
    (help ? `\n\n补权限的直达链接（勾选后要创建版本并发布，还有几分钟生效延迟）：\n${help}` : '')
  )
}

export const scope = 'all'

export default (_ctx: PluginContext) =>
  createSdkMcpServer({
    name: 'larkapi',
    version: '1.0.0',
    tools: [
      tool(
        'find_lark_api',
        '在 Lark OpenAPI 里搜接口。**没有现成 MCP 工具能干的事，先用这个找找有没有对应 API。**' +
          '比如「怎么建日历日程」「怎么查审批单」「怎么建多维表格记录」。' +
          '返回匹配的接口路径，拿到之后用 call_lark_api 调。',
        {
          keyword: z
            .string()
            .describe('关键词，用英文 API 术语搜得准：calendar / approval / bitable / task / vc / attendance …'),
          limit: z.number().int().min(1).max(40).default(20).describe('最多返回几条'),
        },
        async ({ keyword, limit }) => {
          const apis = await loadApiIndex()
          if (!apis.length) return text('读不到 SDK 类型文件，这个功能不可用')

          const kw = keyword.trim().toLowerCase()
          const hit = apis.filter((a) =>
            `${a.project} ${a.resource} ${a.apiName}`.toLowerCase().includes(kw),
          )
          if (!hit.length) {
            const projects = [...new Set(apis.map((a) => a.project))].sort()
            return text(
              `没搜到含「${keyword}」的接口。\n\n可用的模块名（用这些搜命中率高）：\n` +
                projects.join(' ') +
                `\n\n或者直接查文档：https://open.larksuite.com/search?q=${encodeURIComponent(keyword)}`,
            )
          }
          const list = hit.slice(0, limit)
          return text(
            `找到 ${hit.length} 个（显示前 ${list.length} 个）。\n\n` +
              list
                .map((a) => `  client.${a.project}.${a.resource.replace(/\./g, '.')}.${a.apiName}()   [${a.version}]`)
                .join('\n') +
              '\n\n**优先用 SDK 方法名调**（call_lark_api 的 sdk 参数），比拼 URL 可靠。\n' +
              `参数不确定就查文档：https://open.larksuite.com/search?q=${encodeURIComponent(keyword)}`,
          )
        },
      ),
      tool(
        'call_lark_api',
        '直接调 Lark OpenAPI。**先确认没有专门的 MCP 工具能做这件事** —— ' +
          '定时任务用 mcp__schedule__*、发图发文件用 mcp__send__*、云文档用 mcp__doc__*、' +
          '群成员和多维表格用 mcp__lark__*（群聊里才有）。都没有再用这个。' +
          'token 会自动带上，不用自己拼。',
        {
          sdk: z
            .string()
            .optional()
            .describe('SDK 方法名，如 calendar.calendar.list（find_lark_api 给的就是这个，优先用它）'),
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('用 path 时必填'),
          path: z
            .string()
            .optional()
            .describe('接口路径，如 /open-apis/calendar/v4/calendars。没有 SDK 方法时才用'),
          params: z.record(z.string(), z.any()).optional().describe('query 参数'),
          data: z.record(z.string(), z.any()).optional().describe('请求体'),
          path_params: z.record(z.string(), z.any()).optional().describe('路径参数，如 { document_id: "xxx" }'),
        },
        async ({ sdk, method, path, params, data, path_params }) => {
          // 优先走 SDK 方法：路径、版本、参数位置都由 SDK 处理，不用手拼
          if (sdk) {
            const parts = sdk.trim().split('.')
            if (parts.length < 2) return text('SDK 方法名格式：<project>.<resource>.<apiName>')
            // deny 也要管这条路，否则护栏白设 —— 按方法名匹配，语义和路径那边一致
            const denied = denyBySdkName(sdk.trim())
            if (denied) return text(`这个接口不开放：${denied}`)
            const fnName = parts.pop()!
            let node: any = client
            for (const seg of parts) {
              node = node?.[seg]
              if (!node) return text(`SDK 里没有 ${sdk} —— 先用 find_lark_api 确认名字`)
            }
            const fn = node?.[fnName]
            if (typeof fn !== 'function') return text(`SDK 里没有 ${sdk} —— 先用 find_lark_api 确认名字`)
            try {
              const r: any = await fn.call(node, {
                ...(path_params ? { path: path_params } : {}),
                ...(params ? { params } : {}),
                ...(data ? { data } : {}),
              })
              const body = JSON.stringify(r?.data ?? r, null, 2)
              return text(body.length > 12000 ? body.slice(0, 12000) + '\n…（已截断）' : body)
            } catch (e) {
              return text(explainError(e))
            }
          }

          if (!path || !method) return text('要么给 sdk 方法名，要么给 method + path')
          const p = path.trim()
          if (!p.startsWith('/open-apis/')) return text('路径要以 /open-apis/ 开头')
          if (/:[a-zA-Z_]/.test(p)) return text(`路径里还有没替换的参数：${p}`)

          // GET 一律放行 —— 只读没有副作用，读错了最多是浪费一次调用。
          // 写操作按 deny 名单拦。
          if (method !== 'GET') {
            for (const [re, why] of DENY) {
              if (re.test(p)) return text(`这个接口不开放：${why}`)
            }
          }

          try {
            const r: any = await client.request({ method, url: p, params, data })
            const body = JSON.stringify(r?.data ?? r, null, 2)
            return text(body.length > 12000 ? body.slice(0, 12000) + '\n…（已截断）' : body)
          } catch (e) {
            return text(explainError(e))
          }
        },
      ),
    ],
  })
