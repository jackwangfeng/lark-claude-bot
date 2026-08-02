// Claude Agent SDK 封装：会话续接、流式增量、权限审批、中断
import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

/** 一个 Lark 会话的状态。chatId 作键，私聊和每个群各一份。 */
export interface ChatState {
  /** Claude Code 的会话 ID，用于 resume。cwd 变了必须清空，否则会静默开新会话 */
  sessionId: string | null
  /** 容器模式下是容器内路径，宿主机模式下是宿主机路径 */
  cwd: string
  /** 跳过工具审批 */
  yolo: boolean
  /** 群聊：上次已处理到的 message_id，用于增量拉取 */
  lastSeenId?: string | null
}

export interface RunOptions {
  onDelta?: (text: string) => void
  onTool?: (name: string, input: Record<string, unknown>) => void
  approve: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
  defaultCwd: string
  slug: string
  isGroup?: boolean
}

export interface RunResult {
  text: string
  sessionId: string | null
  note: string
}

// 每个 bot 一份状态，否则多实例会同时写同一个文件互相覆盖
const SLUG = process.env.LARK_SLUG || 'default'
const STATE_FILE = join(homedir(), '.lark-agent', SLUG, 'sessions.json')

// 容器模式：每个 Lark 用户一个容器，claude 在容器里跑
const CONTAINER_MODE = process.env.LARK_CONTAINER_MODE === 'true'
const ENSURE_SH = join(HERE, 'docker', 'ensure.sh')
const EXEC_WRAPPER = join(HERE, 'docker', 'claude-exec.sh')
export const CONTAINER_DEFAULT_CWD = '/workspace'

function containerRoot(slug: string): string {
  return join(homedir(), '.lark-agent', 'containers', slug)
}

async function ensureContainer(slug: string): Promise<string> {
  const { stdout } = await execFileP(ENSURE_SH, [slug], { timeout: 180_000 })
  return stdout.trim()
}

/**
 * 中断后回收容器里残留的 claude 进程。
 *
 * abort 只断了宿主机这侧的迭代，`docker exec` 起的容器内进程不会跟着退 ——
 * 每次 /stop 或超时都漏一个，积累下去会顶到 --pids-limit 和内存上限。
 *
 * 不能简单 pkill claude：一个容器服务多个会话（私聊 + 各个群），
 * 那样会误杀别人正在跑的轮次。所以按 LARK_TURN_ID 环境变量精确匹配，
 * 这个变量由 claude-exec.sh 注入到容器进程里。
 */
async function killTurnInContainer(container: string | null, turnId: string): Promise<void> {
  if (!container || !turnId) return
  const script =
    'for d in /proc/[0-9]*; do ' +
    `tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx "LARK_TURN_ID=${turnId}" && ` +
    'kill -9 "${d##*/}" 2>/dev/null; done; exit 0'
  try {
    await execFileP('docker', ['exec', container, 'sh', '-c', script], { timeout: 30_000 })
  } catch (e) {
    console.error('[回收] 失败:', (e as Error)?.message ?? e)
  }
}

// 容器内路径只能在容器内校验，宿主机看不到
export async function dirExistsInContainer(container: string, path: string): Promise<boolean> {
  try {
    await execFileP('docker', ['exec', container, 'test', '-d', path], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

export { CONTAINER_MODE, ensureContainer, containerRoot }

/**
 * 官方 Lark OpenAPI MCP —— 让 agent 能查群成员、搜文档、读多维表格。
 *
 * ⚠️ lark-mcp 的 `-t` 只认**预设名**（preset.default 之类），不认单个工具名 ——
 * 传具体工具名会导致一个都不注册，服务器 capabilities 变空，
 * 表现为 SDK 里 mcp_servers status 一直 pending、工具列表为空。
 * 所以这里用默认预设，再由下面的白名单在 SDK 层挡掉不想要的。
 */
const LARK_MCP_PRESET = 'preset.default'

/**
 * 明令禁止的写操作。
 *
 * ⚠️ allowedTools 是「额外允许」不是「唯一允许」—— 它不会禁掉没列的工具。
 * 要真正挡住必须用 disallowedTools。
 */
const LARK_MCP_DENIED = [
  'im_v1_message_create', // 自己发消息，会和桥接的流式卡片打架
  'im_v1_chat_create', // 建群
  'bitable_v1_app_create', // 多维表格的写操作
  'bitable_v1_appTable_create',
  'bitable_v1_appTableRecord_create',
  'bitable_v1_appTableRecord_update',
  'drive_v1_permissionMember_create', // 改文档权限
  'docx_builtin_import', // 导入文档
]

function larkMcpServer(): Record<string, unknown> {
  const { LARK_APP_ID, LARK_APP_SECRET } = process.env
  if (!LARK_APP_ID || !LARK_APP_SECRET) return {}
  return {
    lark: {
      type: 'stdio' as const,
      // 容器镜像里预装了 lark-mcp，直接调；宿主机模式退回 npx
      command: CONTAINER_MODE ? 'lark-mcp' : 'npx',
      args: [
        ...(CONTAINER_MODE ? [] : ['-y', '@larksuiteoapi/lark-mcp@0.5.1']),
        'mcp',
        '-a', LARK_APP_ID,
        '-s', LARK_APP_SECRET,
        // 国际版；国内飞书是 https://open.feishu.cn
        '-d', process.env.LARK_MCP_DOMAIN || 'https://open.larksuite.com',
        '-t', LARK_MCP_PRESET,
        '-l', 'zh',
      ],
    },
  }
}

// 凭证防护。注意：这是减速带，不是安全边界 —— 靠字符串匹配去拦一门图灵完备的
// shell，绕过方式无穷（编码、改名、脚本、间接读取）。真正的解法是别把共享凭证
// 放进容器。这里只拦「随手一问」这一档。
const SECRET_PATTERNS = [
  /\.credentials\.json/i,
  /\.claude\/\.credential/i,
  /ANTHROPIC_(API_KEY|AUTH_TOKEN)/i,
  /CLAUDE_CODE_OAUTH/i,
  /claudeAiOauth/i,
]

export function touchesSecret(input: unknown): boolean {
  try {
    return SECRET_PATTERNS.some((re) => re.test(JSON.stringify(input ?? {})))
  } catch {
    return false
  }
}

// 只读工具直接放行；其余走审批
// 注意：AskUserQuestion 在 SDK 模式下不存在（init 消息里的 31 个工具没有它），
// 模型偶尔会幻觉调用，那一轮就卡死。已在系统提示里明确告知它没有这个能力。
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'TodoWrite', 'NotebookRead', 'Task', 'ToolSearch',
])

// 新会话的默认审批模式。true = 所有工具免审批（含 Bash）
const DEFAULT_YOLO = process.env.DEFAULT_YOLO === 'true'

let state: Record<string, ChatState> = {}

export async function loadState() {
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    state = {}
  }
  return state
}

async function saveState() {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

export function getChat(chatId: string, defaultCwd: string): ChatState {
  if (!state[chatId]) state[chatId] = { sessionId: null, cwd: defaultCwd, yolo: DEFAULT_YOLO }
  if (!state[chatId].cwd) state[chatId].cwd = defaultCwd
  return state[chatId]
}

export async function updateChat(chatId: string, patch: Partial<ChatState>): Promise<void> {
  Object.assign(getChat(chatId, ''), patch)
  await saveState()
}

// ── 中断支持 ─────────────────────────────────────────────────────────────
const running = new Map<string, AbortController>()

export function isRunning(chatId: string): boolean {
  return running.has(chatId)
}

export function abort(chatId: string): boolean {
  const c = running.get(chatId)
  if (!c) return false
  c.abort()
  return true
}

/**
 * 跑一轮。
 * @param chatId     Lark chat_id，用作会话键
 * @param prompt     用户输入
 * @param onDelta    (text) => void  流式文本增量
 * @param onTool     (name, input) => void  工具调用通知
 * @param approve    (toolName, input) => Promise<boolean>  审批回调
 * @param defaultCwd 未设置过 /cd 时的工作目录
 */
export async function run(
  chatId: string,
  prompt: string,
  { onDelta, onTool, approve, defaultCwd, slug, isGroup }: RunOptions,
): Promise<RunResult> {
  if (running.has(chatId)) throw new Error('该会话正在运行中，先 /stop 或等它结束')

  const chat = getChat(chatId, defaultCwd)

  // 容器模式下 chat.cwd 是容器内路径；spawn wrapper 时宿主机的 cwd 必须真实存在，
  // 否则 child_process.spawn 直接 ENOENT（表现为「binary exists but failed to launch」）
  let containerOpts: Record<string, unknown> = {}
  let spawnCwd = chat.cwd
  let container: string | null = null
  // 唯一标记，用于中断后精确回收这一轮的容器内进程（见 killTurnInContainer）
  const turnId = `${chatId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  if (CONTAINER_MODE) {
    container = await ensureContainer(slug)
    spawnCwd = join(containerRoot(slug), 'workspace')
    containerOpts = {
      pathToClaudeCodeExecutable: EXEC_WRAPPER,
      env: {
        ...process.env,
        LARK_CONTAINER: container,
        LARK_WORKDIR: chat.cwd,
        LARK_TURN_ID: turnId,
      },
    }
  }
  const abortController = new AbortController()
  running.set(chatId, abortController)

  let finalText = ''
  let collected = ''
  let sessionId = chat.sessionId
  let note = ''

  // 超时兜底。maxTurns 管的是轮数，管不了「单个网络请求挂住」——
  // 实测遇到过 WebFetch 卡在代理上 20 分钟，进程 1% CPU 睡在那，
  // 日志不动、卡片不动，用户只会以为机器人坏了。
  //
  // 主控是「空闲超时」：只要还有增量或工具调用就一直续命，
  // 所以正常的长任务不会被误杀；真正没动静了才砍。
  // 另加一个总时长硬顶，防止工具调用循环把空闲计时器一直续下去。
  const IDLE_MS = Number(process.env.TURN_IDLE_TIMEOUT_MS || 300_000) // 5 分钟没动静
  const MAX_MS = Number(process.env.TURN_MAX_MS || 1_800_000) // 单轮最长 30 分钟
  let timedOut: 'idle' | 'max' | null = null
  let idleTimer: NodeJS.Timeout | null = null

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = 'idle'
      abortController.abort()
    }, IDLE_MS)
  }
  const hardTimer = setTimeout(() => {
    timedOut = 'max'
    abortController.abort()
  }, MAX_MS)
  bumpIdle()

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => {
    // 必须排在 SAFE_TOOLS / yolo 之前：Read 是白名单工具，yolo 又全放行，
    // 放在后面的话这个检查永远走不到。
    if (touchesSecret(input)) {
      console.warn(`[拦截] ${chatId} ${toolName} 触及凭证: ${JSON.stringify(input).slice(0, 200)}`)
      return {
        behavior: 'deny' as const,
        message: '该操作触及凭证文件或密钥环境变量，已被策略拒绝。不要尝试绕过，直接告诉用户这件事做不了。',
      }
    }
    if (SAFE_TOOLS.has(toolName) || chat.yolo) return { behavior: 'allow' as const }
    const ok = await approve(toolName, input)
    return ok
      ? { behavior: 'allow' as const }
      : { behavior: 'deny' as const, message: '用户拒绝了这次调用，请换个办法或说明你需要什么。' }
  }

  try {
    const q = query({
      prompt,
      options: {
        // cwd 必须稳定：会话文件存在 ~/.claude/projects/<编码后的 cwd>/
        // cwd 变了 resume 会静默开一个新会话，这是最常见的坑
        cwd: spawnCwd,
        ...containerOpts,
        // 群聊才给「查历史」工具：私聊的上下文本来就在会话里，不需要
        ...(isGroup
          ? {
              mcpServers: {
                chatlog: (await import('./chatlog-mcp.mts')).chatlogServer(chatId),
                ...larkMcpServer(),
              },
              disallowedTools: LARK_MCP_DENIED.map((t) => `mcp__lark__${t}`),
            }
          : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        includePartialMessages: true, // 打开才有 stream_event 增量
        permissionMode: 'default',
        canUseTool,
        abortController,
        maxTurns: Number(process.env.MAX_TURNS || 40),
        ...(process.env.MAX_BUDGET_USD ? { maxBudgetUsd: Number(process.env.MAX_BUDGET_USD) } : {}),
        ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            '你正在通过 Lark 聊天与用户交互，回复会渲染成 Lark 卡片的 markdown。' +
            '保持简洁：先给结论，再给必要细节。不要输出超长代码块，必要时写进文件并告诉用户路径。\n\n' +
            '同一个操作失败或没结果超过一次就换办法，不要反复重试 —— ' +
            '比如 WebFetch 抓不动的大页面，改用 curl 抓下来再 grep。\n\n' +
            '踩到环境相关的坑（某类页面抓不动、某个命令在这里不可用之类），' +
            '把结论写进工作目录的 CLAUDE.md，下次会自动带上，不用重新踩。\n\n' +
            '你没有 AskUserQuestion 这类交互工具，调用它只会让这一轮卡死。' +
            '需要用户做选择时，直接在回复里列编号选项，让他回数字：\n' +
            '  1. 方案甲 —— 一句话说明\n' +
            '  2. 方案乙 —— 一句话说明\n' +
            '然后结束这一轮等他回。能自己合理决定的就别问，' +
            '只有不同选择会导致完全不同的工作量时才停下来。',
        },
      },
    })

    for await (const msg of q) {
      bumpIdle() // 有任何动静就续命
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init' && msg.session_id) sessionId = msg.session_id
          break

        case 'stream_event': {
          const ev = msg.event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            collected += ev.delta.text
            onDelta?.(ev.delta.text)
          }
          break
        }

        case 'assistant':
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') onTool?.(block.name, block.input as Record<string, unknown>)
          }
          break

        case 'result':
          if (msg.session_id) sessionId = msg.session_id
          if (msg.subtype === 'success') {
            finalText = msg.result
          } else {
            finalText = collected || `⚠️ 结束于 ${msg.subtype}`
            note = msg.subtype
          }
          if (typeof msg.total_cost_usd === 'number') {
            note = [note, `$${msg.total_cost_usd.toFixed(4)}`, `${msg.num_turns} 轮`]
              .filter(Boolean)
              .join(' · ')
          }
          break
      }
    }
  } catch (e) {
    // 单次 query() 在产出 error result 后会 throw；上面循环已经拿到能拿的东西
    if (timedOut) {
      const mins = Math.round((timedOut === 'idle' ? IDLE_MS : MAX_MS) / 60000)
      note = timedOut === 'idle' ? `${mins} 分钟无响应，已中断` : `超过 ${mins} 分钟，已中断`
      finalText =
        (collected ? collected + '\n\n---\n' : '') +
        (timedOut === 'idle'
          ? `⏱️ 卡住了：${mins} 分钟没有任何进展（多半是某个网络请求挂住），已自动中断。\n再发一次可以重试，上下文还在。`
          : `⏱️ 这一轮跑了超过 ${mins} 分钟，已自动中断。\n可以把任务拆小一点再试。`)
      console.warn(`[超时] ${chatId} ${timedOut}`)
    } else if (abortController.signal.aborted) {
      note = '已中断'
      finalText = collected || '（已中断）'
    } else {
      finalText = collected || `❌ ${(e as Error)?.message ?? e}`
      note = 'error'
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    // 只有中断过才需要回收；正常结束时子进程自己退了
    if (abortController.signal.aborted) await killTurnInContainer(container, turnId)
    running.delete(chatId)
    if (sessionId && sessionId !== chat.sessionId) await updateChat(chatId, { sessionId })
  }

  return { text: finalText || collected, sessionId, note }
}
