// 插件加载：把「加功能」从「改核心代码」降级成「加一个文件 / 配一行 JSON」。
//
// 两条路：
//   A. plugins/*.mts   —— 需要访问本地上下文（PG、chatId、Lark 凭证）的自研工具
//   B. mcp.json        —— 社区现成的 MCP server，配置即用，不写代码
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, 'plugins')
const MCP_JSON = process.env.LARK_MCP_CONFIG || join(HERE, 'mcp.json')

/** 插件拿得到的上下文。加字段时记得同步 plugins/README.md */
export interface PluginContext {
  chatId: string
  /** 实例名，也是容器名后缀 */
  slug: string
  isGroup: boolean
  /** 发起这一轮的人的 open_id。建文档后要把他加成协作者，否则他打不开 */
  senderOpenId?: string
}

/**
 * 插件模块的约定：
 *   export const scope = 'all' | 'group' | 'dm'   // 可选，默认 all
 *   export default (ctx: PluginContext) => McpServer | null
 * 返回 null 表示这次不启用（比如缺配置）。
 */
export interface PluginModule {
  scope?: 'all' | 'group' | 'dm'
  default: (ctx: PluginContext) => unknown
}

/** 扫描 plugins/ 目录。单个插件坏掉只跳过它，不影响其他。 */
async function loadLocalPlugins(ctx: PluginContext): Promise<Record<string, unknown>> {
  let files: string[]
  try {
    files = (await readdir(PLUGIN_DIR)).filter((f) => f.endsWith('.mts') && !f.startsWith('_'))
  } catch {
    return {} // 没有 plugins/ 目录也正常
  }

  const out: Record<string, unknown> = {}
  for (const f of files.sort()) {
    const name = f.replace(/\.mts$/, '')
    try {
      const mod = (await import(join(PLUGIN_DIR, f))) as PluginModule
      if (typeof mod.default !== 'function') {
        console.error(`[插件] ${name} 没有 default 导出，跳过`)
        continue
      }
      const scope = mod.scope ?? 'all'
      if ((scope === 'group' && !ctx.isGroup) || (scope === 'dm' && ctx.isGroup)) continue
      const server = mod.default(ctx)
      if (server) out[name] = server
    } catch (e) {
      console.error(`[插件] ${name} 加载失败:`, (e as Error).message)
    }
  }
  return out
}

interface McpJsonEntry {
  /** 'stdio'（默认，给了 command 就是它）| 'http' | 'sse' */
  type?: 'stdio' | 'http' | 'sse'
  /** stdio: 可执行文件 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http/sse: 服务地址 */
  url?: string
  headers?: Record<string, string>
  /** 只在群聊 / 只在私聊启用；不写则都启用 */
  scope?: 'all' | 'group' | 'dm'
  /** 明令禁止的工具名（不带 mcp__<server>__ 前缀） */
  deny?: string[]
  disabled?: boolean
}

/** 把 ${VAR} 换成进程环境变量的值 —— 密钥就不用写进 json 了 */
const expand = (v: string): string =>
  v.replace(/\$\{(\w+)\}/g, (_, n: string) => process.env[n] ?? '')

const expandAll = (o?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, expand(v)]))

/**
 * 读 mcp.json —— 社区现成的 MCP server 配置即用。
 * 格式和 Claude Code 的 mcpServers 一致，额外支持 scope / deny / disabled。
 *
 * ⚠️ 容器模式下这些 server 由容器内的 CLI spawn，所以 command 必须在镜像里存在。
 */
async function loadJsonServers(
  ctx: PluginContext,
): Promise<{ servers: Record<string, unknown>; denied: string[] }> {
  let raw: string
  try {
    raw = await readFile(MCP_JSON, 'utf8')
  } catch {
    return { servers: {}, denied: [] }
  }

  let cfg: { mcpServers?: Record<string, McpJsonEntry> }
  try {
    cfg = JSON.parse(raw)
  } catch (e) {
    console.error(`[插件] ${MCP_JSON} 不是合法 JSON:`, (e as Error).message)
    return { servers: {}, denied: [] }
  }

  const servers: Record<string, unknown> = {}
  const denied: string[] = []
  for (const [name, e] of Object.entries(cfg.mcpServers ?? {})) {
    if (e.disabled) continue
    const scope = e.scope ?? 'all'
    if ((scope === 'group' && !ctx.isGroup) || (scope === 'dm' && ctx.isGroup)) continue
    const kind = e.type ?? (e.command ? 'stdio' : e.url ? 'http' : null)
    if (kind === 'stdio') {
      if (!e.command) {
        console.error(`[插件] ${name} 缺 command，跳过`)
        continue
      }
      const env = expandAll(e.env)
      servers[name] = {
        type: 'stdio' as const,
        command: e.command,
        args: (e.args ?? []).map(expand),
        ...(Object.keys(env).length ? { env } : {}),
      }
    } else if (kind === 'http' || kind === 'sse') {
      if (!e.url) {
        console.error(`[插件] ${name} 缺 url，跳过`)
        continue
      }
      const headers = expandAll(e.headers)
      servers[name] = {
        type: kind,
        url: expand(e.url),
        ...(Object.keys(headers).length ? { headers } : {}),
      }
    } else {
      console.error(`[插件] ${name} 既没有 command 也没有 url，跳过`)
      continue
    }
    for (const t of e.deny ?? []) denied.push(`mcp__${name}__${t}`)
  }
  return { servers, denied }
}

/** 汇总所有插件。同名时本地插件优先 —— 自研的更贴合场景。 */
export async function loadPlugins(
  ctx: PluginContext,
): Promise<{ mcpServers: Record<string, unknown>; disallowedTools: string[] }> {
  const [local, json] = await Promise.all([loadLocalPlugins(ctx), loadJsonServers(ctx)])
  return {
    mcpServers: { ...json.servers, ...local },
    disallowedTools: json.denied,
  }
}
