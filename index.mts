// Lark ↔ Claude 桥接：收消息 → 鉴权/去重/命令 → 排队 → agent.run → 流式卡片
import {
  makeWSClient, eventDispatcher, sendText, startStreamCard, react, getBotInfo,
  getRecentUserText, getMessage, fetchGroupSince, renderMessages, senderName, downloadResource,
  fetchMissedEvents, patchCard, buildCard,
} from './lark.mts'
import { saveMessages, pingDb, recentMessages } from './db.mts'
import { planAttach, type SavedFile } from './attach.mts'
import { stripMentions, mentionedAll } from './mention.mts'
import { poolStatus } from './accounts.mts'
import { sweep as sweepCards } from './pending-cards.mts'
import { startEmbeddingWorker } from './embed-worker.mts'
import { startScheduler } from './scheduler.mts'
import {
  loadState, getChat, updateChat, run, isRunning, abort, knownChats,
  CONTAINER_MODE, CONTAINER_DEFAULT_CWD, ensureContainer, dirExistsInContainer,
} from './agent.mts'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** catch 里的 e 在 TS 是 unknown；Lark SDK 把业务错误塞在 e.response.data.msg */
function errMsg(e: unknown): string {
  const x = e as { response?: { data?: { msg?: string } }; message?: string }
  return x?.response?.data?.msg ?? x?.message ?? String(e)
}


// 这个实例（= 这个 bot）对应的容器。一个 bot 一个进程一个容器。
// 多 bot 就是多实例，各自设不同的 LARK_SLUG。
const SLUG = process.env.LARK_SLUG || 'default'

// 每个 bot 一份白名单，放在自己的状态目录里
const STATE_DIR = join(homedir(), '.lark-agent', SLUG)
const USERS_FILE = process.env.LARK_USERS_FILE || join(STATE_DIR, 'users.json')

// 私聊白名单，按 mtime 热加载：加人只要改 users.json，不用重启服务。
// 格式：{ "<open_id>": { "slug": "alice" } }，slug 现在只当显示名用——
// 容器是 bot 维度（见 SLUG），不再由用户决定。
let usersCache = { mtime: -1, map: new Map() }

function loadUsers() {
  try {
    const { mtimeMs } = statSync(USERS_FILE)
    if (mtimeMs === usersCache.mtime) return usersCache.map
    const raw = JSON.parse(readFileSync(USERS_FILE, 'utf8'))
    const map = new Map(
      Object.entries(raw as Record<string, unknown>).map(([id, v]) => [
        id,
        (typeof v === 'string' ? v : (v as { slug?: string } | null)?.slug) || `u${id.slice(-8)}`,
      ] as const),
    )
    usersCache = { mtime: mtimeMs, map }
    console.log(`[用户表] 已加载 ${map.size} 人：${[...map.entries()].map(([, s]) => s).join(', ')}`)
    return map
  } catch (e) {
    // 文件写坏时保住上一份好的，不要把所有人踢出去
    console.error(`[用户表] 读取失败（沿用上一份 ${usersCache.map.size} 人）:`, (e as Error).message)
    return usersCache.map
  }
}
// 启动时自动获取；拿不到就退化成「群里有任何 @ 都算」（会误触发，但不至于完全不响应）
let BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID || ''
// 容器模式下工作目录是容器内路径；宿主模式下是宿主机路径
const DEFAULT_CWD = CONTAINER_MODE
  ? CONTAINER_DEFAULT_CWD
  : process.env.DEFAULT_CWD || process.cwd()

const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS || 120_000)

// 群聊每轮自动带上的最近几条。只保「接得上话」，更早的让模型用 mcp__chatlog__* 自己搜
const GROUP_CONTEXT_N = Number(process.env.GROUP_CONTEXT_N || 10)

// 私聊是否也入库。默认否，理由见下面 archive() 的调用处
const ARCHIVE_DM = process.env.ARCHIVE_DM === 'true'

// 已经提示过「你不在白名单」的人。任何人都能私聊 bot，每条都回就成了回声墙。
// 只在内存里，进程重启后会重新提示一次 —— 无所谓，总比无限回复强。
const notifiedUnauth = new Set<string>()

// ── 去重：Lark 事件会重投 ──────────────────────────────────────────────────
//
// TTL 必须大于 Lark 补投的最长间隔，否则重连补拉（catchUp）刚处理完的消息，
// 会在 Lark 的退避时钟到点后再被投一次，用户看到机器人把同一句话回两遍。
// 实测补投档位是 ~317s 和 ~3917s（约 65 分钟），所以留到 2 小时。
// 代价只是一个 message_id 的 Map，量级可以忽略。
const SEEN_TTL_MS = Number(process.env.LARK_SEEN_TTL_MS || 2 * 3600_000)
const seen = new Map<string, number>()
function isDuplicate(id: string): boolean {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

// 会话大到一定程度就提醒。
//
// 自动压缩指望不上：它按上下文窗口占比触发（~90%），而窗口有 100 万 token，
// 意味着要涨到 90 万才动手 —— 那时每轮光是读缓存就 $1.35，重写要 $16.9。
// 实测五个实例、几百轮对话，一次都没触发过。
//
// 只提醒不自动压：压缩会丢细节，该不该压用户比我们清楚。
const CONTEXT_WARN_TOKENS = Number(process.env.CONTEXT_WARN_TOKENS || 150_000)

/**
 * 群聊上下文超过这个数就自动开新会话（0 = 关闭）。
 *
 * **只对群聊做**，私聊不做 —— 群的历史在 PG 里（每条消息 + bot 回复都存了，
 * 还有向量检索），重置只丢「这一轮任务的工作记忆」，历史随时能捞回来；
 * 私聊没有这层兜底，丢了就得让 agent 自己去翻 .jsonl。
 *
 * 群里本来就人多话杂、话题切换频繁，长上下文的边际价值低而成本是线性的：
 * 实测一个群聊到 478k 时单轮 $1.05，重置后回到 $0.06 量级。
 */
const GROUP_AUTO_RESET_TOKENS = Number(process.env.GROUP_AUTO_RESET_TOKENS || 300_000)

/** 每个会话上一轮的上下文大小，给 /status 看 */
const lastContext = new Map<string, number>()

function contextHint(tok?: number): string {
  if (!tok || tok < CONTEXT_WARN_TOKENS) return ''
  // 缓存命中时约 $1.5/M，没命中要 $18.75/M —— 用命中价估，说少不说多
  const perTurn = (tok / 1e6) * 1.5
  return `上下文 ${Math.round(tok / 1000)}k ≈ $${perTurn.toFixed(2)}/轮，建议 /compact 或 /new`
}

// ── 按 chat 串行排队 ──────────────────────────────────────────────────────
const queues = new Map<string, Promise<unknown>>()
function enqueue(chatId: string, fn: () => Promise<void>): Promise<unknown> {
  const prev = queues.get(chatId) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    chatId,
    next.catch(() => {}),
  )
  return next
}

// ── 审批：问一句，等这个 chat 的下一条消息作答 ────────────────────────────
const pendingApprovals = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout }>()

function describeTool(name: string, input: Record<string, unknown> = {}): string {
  if (name === 'Bash') return '```\n' + String(input.command || '').slice(0, 1500) + '\n```'
  if (input.file_path) return '`' + input.file_path + '`'
  const s = JSON.stringify(input)
  return '`' + (s.length > 500 ? s.slice(0, 500) + '…' : s) + '`'
}

function askApproval(chatId: string, toolName: string, input: Record<string, unknown>): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(chatId)
      sendText(chatId, `⏱️ ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s 未回复，已拒绝 ${toolName}`).catch(() => {})
      res(false)
    }, APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(chatId, { resolve: res, timer })
    sendText(
      chatId,
      `⚠️ 需要批准 **${toolName}**\n\n${describeTool(toolName, input)}\n\n回复 y 批准 / n 拒绝` +
        `（${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s 不回默认拒绝）`,
    ).catch(() => {})
  })
}

// ── 解析入站消息 ──────────────────────────────────────────────────────────
function extractText(message: Record<string, any>): string {
  let c
  try {
    c = JSON.parse(message.content)
  } catch {
    return ''
  }
  if (message.message_type === 'text') return c.text || ''
  if (message.message_type === 'post') {
    // 富文本：把所有 text 节点拼起来
    const out: string[] = []
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>
        if (o.tag === 'text' && typeof o.text === 'string') out.push(o.text)
        Object.values(o).forEach(walk)
      }
    }
    walk(c)
    return out.join(' ')
  }
  return ''
}

interface Attachment {
  /** 下载用的 key。图片是 image_key，其余是 file_key */
  key: string
  /** messageResource 接口的 type 参数，只认 'image' / 'file' */
  api: 'image' | 'file'
  /** 给用户看的类别 */
  kind: string
  name?: string
}

/**
 * 从消息里抠出附件。图片、文件、音频、视频，以及富文本里内嵌的图。
 * 贴纸(sticker)不要 —— 那是表情，下载下来没意义还占地方。
 */
function extractAttachments(message: Record<string, any>): Attachment[] {
  let c: Record<string, any>
  try {
    c = JSON.parse(message.content)
  } catch {
    return []
  }
  const t = message.message_type
  if (t === 'image' && c.image_key) return [{ key: c.image_key, api: 'image', kind: '图片' }]
  if (t === 'file' && c.file_key)
    return [{ key: c.file_key, api: 'file', kind: '文件', name: c.file_name }]
  if (t === 'audio' && c.file_key) return [{ key: c.file_key, api: 'file', kind: '语音' }]
  if (t === 'media' && c.file_key)
    return [{ key: c.file_key, api: 'file', kind: '视频', name: c.file_name }]
  if (t === 'post') {
    // 富文本可以图文混排，把内嵌的图也抠出来
    const out: Attachment[] = []
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>
        if (o.tag === 'img' && typeof o.image_key === 'string')
          out.push({ key: o.image_key, api: 'image', kind: '图片' })
        Object.values(o).forEach(walk)
      }
    }
    walk(c)
    return out
  }
  return []
}

/** 纯附件消息没有文本，存档时用它占位，免得回看历史断一截 */
function placeholderOf(message: Record<string, any>): string {
  const a = extractAttachments(message)
  if (!a.length) return ''
  return a.map((x) => (x.name ? `[${x.kind}: ${x.name}]` : `[${x.kind}]`)).join(' ')
}

// 附件落在工作目录下的 uploads/。
// ⚠️ 容器模式下要写宿主机路径，但告诉 Claude 的必须是容器内路径 —— 它在容器里跑。
const UPLOAD_HOST_DIR = CONTAINER_MODE
  ? join(homedir(), '.lark-agent', 'containers', SLUG, 'workspace', 'uploads')
  : join(DEFAULT_CWD, 'uploads')
const UPLOAD_SEEN_DIR = CONTAINER_MODE ? `${CONTAINER_DEFAULT_CWD}/uploads` : UPLOAD_HOST_DIR

// 连发的附件先攒着，安静下来再一起跑。
// Lark 是「一张图一条消息」，连发 3 张就是 3 个事件 —— 不合并的话会触发 3 轮
// Claude：又慢又贵，而且模型每轮只看得到一张，没法对比着说。
const ATTACH_DEBOUNCE_MS = Number(process.env.ATTACH_DEBOUNCE_MS || 2500)
const attachBuf = new Map<string, { files: SavedFile[]; timer?: NodeJS.Timeout }>()

/** 下载附件，返回给 Claude 看的路径。单个失败只跳过它，不影响这一轮 */
async function saveAttachments(
  messageId: string,
  atts: Attachment[],
): Promise<SavedFile[]> {
  await mkdir(UPLOAD_HOST_DIR, { recursive: true })
  const out: SavedFile[] = []
  for (const [i, a] of atts.entries()) {
    // 文件名带上 message_id：同名文件互相覆盖会让 Claude 读到上一次的内容
    const safe = (a.name || '').replace(/[^\w.\-一-龥]/g, '_').slice(-60)
    const ext = safe.includes('.') ? '' : a.api === 'image' ? '.jpg' : '.bin'
    const fname = `${messageId.slice(-12)}_${i}${safe ? `_${safe}` : ''}${ext}`
    try {
      await downloadResource(messageId, a.key, a.api, join(UPLOAD_HOST_DIR, fname))
      out.push({ path: `${UPLOAD_SEEN_DIR}/${fname}`, kind: a.kind })
    } catch (e) {
      console.error(`[附件] ${a.kind} 下载失败:`, errMsg(e))
    }
  }
  return out
}

function mentionedBot(mentions: Array<{ id?: { open_id?: string } }> = []): boolean {
  if (!mentions.length) return false
  // 没拿到自身 open_id 时只能退化：宁可误响应，也别整个群里失灵
  if (!BOT_OPEN_ID) return true
  return mentions.some((m) => m.id?.open_id === BOT_OPEN_ID)
}

// ── 斜杠命令 ──────────────────────────────────────────────────────────────
const HELP = [
  '**可用命令**',
  '`/new` 开新会话（清掉上下文）',
  '`/cd <路径>` 切工作目录（会同时开新会话）',
  '`/stop` 中断当前任务',
  '`/status` 看会话状态',
  '`/yolo on|off` 本会话跳过审批（默认 off）',
  '`/help` 这条',
  '',
  '其余斜杠命令直接转给 Claude Code，例如：',
  '`/usage` 用量和额度 · `/context` 上下文占用 · `/compact` 压缩上下文',
  '`/model` 换模型 · `/effort` 调用力度 · `/doctor` 自检',
].join('\n')

async function handleCommand(chatId: string, text: string): Promise<boolean> {
  const [cmd = '', ...rest] = text.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  const chat = getChat(chatId, DEFAULT_CWD)

  switch (cmd.toLowerCase()) {
    case 'help':
      await sendText(chatId, HELP)
      return true

    case 'new':
      await updateChat(chatId, { sessionId: null })
      await sendText(chatId, '🆕 已开新会话')
      return true

    case 'stop':
      await sendText(chatId, abort(chatId) ? '⏹️ 已中断' : '当前没有在跑的任务')
      return true

    case 'status':
      await sendText(
        chatId,
        [
          `运行位置：${CONTAINER_MODE ? '容器 `lark-' + SLUG + '`' : '宿主机'}`,
          `工作目录：\`${chat.cwd}\``,
          `会话：${chat.sessionId ? '`' + chat.sessionId + '`' : '（新会话）'}`,
          `yolo：${chat.yolo ? 'on ⚠️' : 'off'}`,
          `运行中：${isRunning(chatId) ? '是' : '否'}`,
          lastContext.has(chatId)
            ? `上下文：${Math.round(lastContext.get(chatId)! / 1000)}k tok` +
              (lastContext.get(chatId)! >= CONTEXT_WARN_TOKENS ? '  ⚠️ 建议 `/compact`' : '')
            : '',
          await poolStatus().then((p) => (p ? `\n**账号池**\n\`\`\`\n${p}\n\`\`\`` : '')),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return true

    case 'yolo': {
      if (arg !== 'on' && arg !== 'off') {
        await sendText(chatId, '用法：`/yolo on` 或 `/yolo off`')
        return true
      }
      await updateChat(chatId, { yolo: arg === 'on' })
      await sendText(
        chatId,
        arg === 'on' ? '⚠️ yolo 已开：本会话所有工具免审批（这台机器免密 sudo，注意）' : '✅ yolo 已关',
      )
      return true
    }

    case 'cd': {
      if (!arg) {
        await sendText(chatId, '用法：`/cd /path/to/dir`')
        return true
      }
      let p
      if (CONTAINER_MODE) {
        // 容器内路径，宿主机看不到，只能进容器里校验
        p = arg.startsWith('/') ? arg : `${CONTAINER_DEFAULT_CWD}/${arg}`
        const container = await ensureContainer(SLUG)
        if (!(await dirExistsInContainer(container, p))) {
          await sendText(chatId, `❌ 容器 \`${container}\` 里没有这个目录：\`${p}\``)
          return true
        }
      } else {
        p = resolve(arg.replace(/^~(?=$|\/)/, homedir()))
        if (!existsSync(p) || !statSync(p).isDirectory()) {
          await sendText(chatId, `❌ 目录不存在：\`${p}\``)
          return true
        }
      }
      // cwd 变了 resume 会静默开新会话，所以主动清掉 sessionId
      await updateChat(chatId, { cwd: p, sessionId: null })
      await sendText(chatId, `📁 工作目录 → \`${p}\`\n（已同时开新会话）`)
      return true
    }

    default:
      // 不是桥接的命令 —— 交给 Claude Code 自己处理（/usage /context /compact /model …）。
      // 返回 false 表示「没接住」，调用方会把原文当普通消息发下去。
      return false
  }
}

// ── 主处理 ────────────────────────────────────────────────────────────────
async function onMessage(data: Record<string, any>): Promise<void> {
  const { message, sender } = data
  if (!message?.message_id) return

  const chatId = message.chat_id
  const openId = sender?.sender_id?.open_id
  const isGroup = message.chat_type === 'group'

  // ⚠️ open_id 是按应用隔离的：同一个人在不同 bot 下是两个不同的 open_id。
  // union_id / user_id 才在同租户内跨应用稳定。白名单三者任一命中即可，
  // 这样既兼容已有的 open_id 白名单，新加的人又能用 union_id 一份通用。
  const senderIds = [
    sender?.sender_id?.open_id,
    sender?.sender_id?.union_id,
    sender?.sender_id?.user_id,
  ].filter(Boolean)

  if (process.env.LARK_DEBUG_SENDER === 'true') {
    console.log(`[sender] ${JSON.stringify(sender?.sender_id || {})}`)
  }

  // 合并附件时会拿同一条 message_id 重新进来一次，那轮要跳过去重和存档 ——
  // 否则会被自己第一次留下的记录挡掉，或者把同一条消息存两遍。
  if (!data.__attachFlush && isDuplicate(message.message_id)) return

  // 记下会话类型，断线重连补拉时要用（拉历史的接口不返回 chat_type）
  const known = getChat(chatId, DEFAULT_CWD)
  if (known.chatType !== (isGroup ? 'group' : 'p2p')) {
    updateChat(chatId, { chatType: isGroup ? 'group' : 'p2p' }).catch(() => {})
  }

  const mentions = message.mentions || []
  const users = loadUsers()

  const archive = async (): Promise<void> => {
    // 存清理过 mention 占位符的文本：原文里是 "@_user_1 你好"，
    // 存进去会污染检索（搜不到、也读不懂谁在跟谁说话）。
    // 纯图片/文件消息没有文本，存个占位符 —— 不然回看历史时会凭空断一截。
    const body = stripMentions(extractText(message), mentions).trim() || placeholderOf(message)
    if (!body || !String(openId).startsWith('ou_')) return
    await saveMessages(SLUG, [
      {
        messageId: message.message_id,
        chatId,
        senderId: openId,
        // 私聊取不到群成员名单，退回白名单里的显示名，免得历史里全是「用户a10e」
        senderName:
          (await senderName(chatId, openId)) ??
          (isGroup ? undefined : senderIds.map((id) => users.get(id)).find(Boolean)),
        msgType: message.message_type ?? 'text',
        content: body,
        sentAt: Number(message.create_time) || Date.now(),
      },
    ]).catch((e) => console.error('[存档] 写入失败:', errMsg(e)))
  }

  // 群消息一律先存 —— 应用有 im:message.group_msg:readonly，没被 @ 的消息也会推过来。
  // 存储和「要不要回应」是两件事：存是为了长期记忆，回应才看 @。
  // 放在授权检查之前：群里所有人的发言都是上下文，不该因为发言人不在白名单就丢掉。
  if (isGroup && !data.__attachFlush) void archive()

  // 授权模型按会话类型分：
  //   私聊 —— 必须在 users.json 里（可用范围在私聊场景是硬约束，这里再兜一层）
  //   群聊 —— 群成员名单即授权名单，任何人 @ 都服务；但群成员能进的只有这个群自己的容器
  if (isGroup) {
    if (!mentionedBot(mentions) && !mentionedAll(message)) {
      // ⚠️ 这里以前是光秃秃一个 return —— 整套系统最大的观测盲区：
      // 「@ 了但没反应」和「压根没收到这条」在日志里长得一模一样，没法查。
      // 只在「@ 了人但判定不是我」时记一行（群里绝大多数消息没有 @，全打会淹掉日志）。
      // 真出现「明明 @ 了我却被丢」时，这行会把收到的原始 mentions 打出来，一次定位。
      if (mentions.length) {
        console.log(`[未@我] ${chatId} 收到的 mentions=${JSON.stringify(mentions)}`)
      }
      return
    }
  } else if (senderIds.some((id) => users.has(id))) {
    // 记下这个私聊对面是谁 —— 补拉时只有 open_id，靠它认人（见下）
    if (openId && known.peerOpenId !== openId) {
      updateChat(chatId, { peerOpenId: openId }).catch(() => {})
    }
  } else if (data.__catchup && openId && openId === known.peerOpenId) {
    // 补拉回来的私聊消息只带 open_id（拉历史的接口不返回 union_id），
    // 而白名单推荐配 union_id，直接比对必然落空。
    // 这里退回到「这个会话上次通过鉴权的就是这个 open_id」，只认它本人，
    // 不放宽给任意人。代价：白名单里移除某人后，补拉窗口内（≤2h）仍可能服务他一次。
  } else {
    // 从这条日志里挑一个填进 users.json。推荐用 union_id —— 换 bot 也不用重配。
    console.log(`[忽略] 未授权私聊 ${JSON.stringify(sender?.sender_id || {})}`)

    // 告诉对方该找谁、报哪个 ID —— 干等着不回，只会让人以为 bot 坏了。
    // ⚠️ 每人只提示一次：任何人都能私聊这个 bot，每条都回就成了免费的回声墙，
    // 有人一直发就一直回。进程重启后会重新提示一次，可以接受。
    // union_id 拿不到就退回 open_id —— 它也能填进白名单（只是换 bot 要重配），
    // 总比什么都不说强。去重键用 chatId 兜底，保证「每人只提示一次」不会失效。
    const uid = sender?.sender_id?.union_id || sender?.sender_id?.open_id
    if (!notifiedUnauth.has(uid || chatId)) {
      notifiedUnauth.add(uid || chatId)
      await sendText(
        chatId,
        uid
          ? '你还不在这个机器人的白名单里。\n\n' +
              '把下面这行发给管理员，加进去就能用了：\n\n' +
              `\`${uid}\`\n\n` +
              '（加完即刻生效，不用重启，也不用重新加好友）'
          : '你还不在这个机器人的白名单里，而且没能取到你的 ID。\n\n' +
              '找管理员看一下服务日志里的 `[忽略] 未授权私聊` 那行。',
      ).catch(() => {})
    }
    return
  }

  // 私聊默认不入库 —— 上下文本来就在 Claude Code 的会话里，而且落盘
  // （~/.claude/projects/**/*.jsonl，agent 在容器里能直接 rg，连自己的回复都在），
  // 再存一份 PG 是重复的，还把私聊内容放进了共享库。
  // 开 ARCHIVE_DM=true 才存；那时放在鉴权之后 —— 和群聊相反，
  // 群里所有人的发言都是上下文，但私聊里未授权的人不该在库里留记录。
  if (!isGroup && ARCHIVE_DM && !data.__attachFlush) void archive()

  const raw = extractText(message)
  let text = stripMentions(raw, mentions)

  // 附件：下载到工作目录，把路径给 Claude，它自己会 Read（图片能直接看）。
  //
  // 连发的多个附件要合并成一轮 —— Lark 是「一张图一条消息」，发 3 张就是 3 个事件。
  // 不合并会触发 3 轮 Claude：又慢又贵，而且模型每轮只看得到一张，没法对比着说。
  // 纯附件消息先攒进缓冲区等一等；期间补了文字就立刻连附件一起发出去
  //（"几张图 + 一句话" 是最常见的发法）。
  let saved: SavedFile[] = (data.__attachments as SavedFile[] | undefined) ?? []
  if (!data.__attachFlush) {
    const atts = extractAttachments(message)
    const got = atts.length ? await saveAttachments(message.message_id, atts) : []
    if (atts.length && !got.length && !text) {
      await sendText(chatId, '附件下载失败了，你再发一次或者改用文字描述吧')
      return
    }

    const buf = attachBuf.get(chatId)
    const plan = planAttach({
      pending: buf?.files,
      incoming: got,
      hasText: Boolean(text),
      isCmd: text.startsWith('/'),
    })

    if (plan.action !== 'pass') {
      if (buf?.timer) clearTimeout(buf.timer)
      if (plan.action === 'wait') {
        const files = plan.files
        const timer = setTimeout(() => {
          attachBuf.delete(chatId)
          console.log(`[附件] ${chatId} 合并 ${files.length} 个为一轮`)
          void onMessage({ ...data, __attachFlush: true, __attachments: files }).catch((e) =>
            console.error('[附件] 合并处理失败:', errMsg(e)),
          )
        }, ATTACH_DEBOUNCE_MS)
        attachBuf.set(chatId, { files, timer })
        return
      }
      attachBuf.delete(chatId)
      saved = plan.files
    }
  }

  if (saved.length) {
    console.log(`[附件] ${chatId} 本轮 ${saved.length} 个：${saved.map((s) => s.kind).join('、')}`)
    text =
      (text || '用户发来了附件，没有附带文字。先看看是什么，再回应。') +
      '\n\n【用户发来的附件，已下载到本地】\n' +
      saved.map((s) => `- ${s.kind}：${s.path}`).join('\n') +
      '\n（图片直接用 Read 工具看；文档按后缀选合适的方式读）'
  }

  // 光 @ 一下、没带内容：接着上一句。
  // 优先用「被回复的那条」，其次用会话里最近一条人发的消息。
  if (!text) {
    if (message.message_type !== 'text' && message.message_type !== 'post') {
      await sendText(chatId, `暂不支持 \`${message.message_type}\` 类型的消息，发文字吧`)
      return
    }
    let prev = null
    try {
      prev = message.parent_id
        ? await getMessage(message.parent_id)
        : await getRecentUserText(chatId, message.message_id)
    } catch (e) {
      console.error('[取上一句] 失败:', errMsg(e))
    }
    if (!prev?.text) {
      await sendText(chatId, '你 @ 了我但没说要干嘛，也没找到上一条消息 🤔')
      return
    }
    console.log(`[接上句] ${chatId}: ${prev.text.slice(0, 60)}`)
    text =
      '用户在群里 @ 了你，但没有写具体内容，意思是让你针对上一条消息作出回应。\n\n' +
      `上一条消息：\n${prev.text}`
  }

  // 审批应答优先于队列 —— 此时 run() 正卡在 await，队列是堵的
  const pending = pendingApprovals.get(chatId)
  if (pending) {
    const a = text.trim().toLowerCase()
    const yes = ['y', 'yes', '批准', '同意', 'ok', '好'].includes(a)
    const no = ['n', 'no', '拒绝', '不'].includes(a)
    if (yes || no) {
      clearTimeout(pending.timer)
      pendingApprovals.delete(chatId)
      pending.resolve(yes)
      await react(message.message_id, yes ? 'THUMBSUP' : 'CROSS')
      return
    }
    await sendText(chatId, '正在等审批，请先回复 y 或 n')
    return
  }

  // 容器是 bot 维度：一个 bot 一个进程一个容器，私聊和群聊都进它。
  // 隔离靠「一个 bot 对应一个主体」来保证 —— 要隔开就再建一个 bot，另起一个实例。
  // 会话仍按 chat_id 分（私聊和各个群是独立上下文），只是共用同一份文件系统。
  if (isGroup) console.log(`[群] ${chatId} 发言人 ${openId}`)

  // 桥接自己的命令优先；接不住的（/usage /context /compact /model 等）
  // 原样转发给 Claude Code，它自己支持这些斜杠命令。
  if (text.startsWith('/') && (await handleCommand(chatId, text))) return

  // 群聊：把上次之后的群内对话补进来。
  // 机器人只在被 @ 时收到消息，人跟人聊的它看不见 —— 不补的话它每次都是从零开始。
  // 增量：只补 lastSeenId 之后的，更早的在会话历史里已经有了。
  let prompt = text
  if (isGroup) {
    // 上下文一律从 PG 读 —— 消息在到达时就实时入库了，不依赖 Lark 的历史 API。
    // 这很重要：拉历史需要 im:message.group_msg 权限，很多 bot 没有；
    // 而只要能收到消息（im:message.group_msg:readonly）就能存，所以 PG 里的数据是全的。
    // 只塞够「接得上话」的量，深度让它自己搜。
    // 塞多少是个取舍：塞得多每条群消息都烧 token，而且窗口固定，
    // 有时嫌少（要翻几个月前）有时嫌多（就问一句无关的）。
    // 既然已经给了 mcp__chatlog__*（关键词 / 语义 / 取更多最近的），
    // 「要翻多久以前」这个判断本就该交给模型，桥接只保底最近这几句的连贯性。
    try {
      const rows = await recentMessages(chatId, GROUP_CONTEXT_N + 1)
      // 最后一条是刚 @ 我的这句，已经在 text 里了
      const ctx = rows
        .filter((m) => m.messageId !== message.message_id)
        .slice(-GROUP_CONTEXT_N)
        .map((m) => `${m.senderName || `用户${m.senderId.slice(-4)}`}: ${m.content}`)
      if (ctx.length) {
        prompt =
          `【群里最近 ${ctx.length} 条对话，了解上下文即可，不必逐条回应】\n${ctx.join('\n')}\n\n` +
          '【更早的没有贴出来。需要时自己查：mcp__chatlog__search_chat_history 按关键词、' +
          'mcp__chatlog__semantic_search_chat_history 按意思、' +
          'mcp__chatlog__recent_chat_history 取更多最近的】\n\n' +
          `【下面是 @ 你的这条，回应这个】\n${text}`
      }
      console.log(`[群上下文] ${chatId} 从库里取了 ${ctx.length} 条`)
    } catch (e) {
      console.error('[群上下文] 失败:', errMsg(e))
    }

    // 补洞：服务重启/断网期间推送丢失的消息，靠翻页找回。
    // 需要 im:message.group_msg 权限；没有就跳过 —— 实时存已经覆盖绝大多数情况。
    void (async () => {
      try {
        const chat = getChat(chatId, DEFAULT_CWD)
        const { messages, newestId } = await fetchGroupSince(chatId, chat.lastSeenId)
        if (messages.length) {
          const n = await saveMessages(
            SLUG,
            messages.map((m) => ({
              messageId: m.id,
              chatId,
              senderId: m.sender,
              senderName: null,
              msgType: 'text',
              content: m.text,
              sentAt: m.at,
            })),
          )
          if (n) console.log(`[补洞] ${chatId} 补回 ${n} 条`)
        }
        if (newestId) await updateChat(chatId, { lastSeenId: newestId })
      } catch {
        // 缺 im:message.group_msg 就静默跳过，不影响主流程
      }
    })()
  }

  console.log(`[收到] ${chatId} ${openId}: ${text.slice(0, 80)}`)

  enqueue(chatId, async () => {
    const t0 = Date.now()
    const card = await startStreamCard(chatId)
    try {
      const { text: final, note, contextTokens } = await run(chatId, prompt, {
        defaultCwd: DEFAULT_CWD,
        slug: SLUG,
        isGroup,
        senderOpenId: openId,
        onDelta: (d) => card.push(d),
        onTool: (name, input) => {
          // 免审批模式下这是唯一的留痕，落 journal 便于事后追查
          console.log(`[工具] ${chatId} ${name} ${JSON.stringify(input).slice(0, 300)}`)
          card.push(`\n\n> 🔧 **${name}** ${describeTool(name, input)}\n\n`)
        },
        approve: (name, input) => askApproval(chatId, name, input),
      })
      if (contextTokens) lastContext.set(chatId, contextTokens)
      await card.finish(final, [note, contextHint(contextTokens)].filter(Boolean).join(' · '))

      // 群聊上下文过大就自动开新会话。放在回复发出**之后**，
      // 这一轮该用的上下文已经用完了，不影响本次质量，只影响下一轮。
      if (isGroup && GROUP_AUTO_RESET_TOKENS > 0 && (contextTokens ?? 0) >= GROUP_AUTO_RESET_TOKENS) {
        await updateChat(chatId, { sessionId: null }).catch(() => {})
        lastContext.delete(chatId)
        console.log(`[会话] ${chatId} 上下文 ${Math.round((contextTokens ?? 0) / 1000)}k，已自动重置`)
        await sendText(
          chatId,
          `🔄 上下文已达 ${Math.round((contextTokens ?? 0) / 1000)}k，自动开了新会话（省钱）。\n\n` +
            '**群里的历史没丢** —— 每条消息和我的回复都存着，' +
            '要翻旧账直接问我就行，我会去检索。',
        ).catch(() => {})
      }

      // 把 bot 自己的回复也存档。
      //
      // 原来只存用户发言，所以 /new 之后 agent 用 chatlog 检索，只能搜到
      // 「别人问过什么」，搜不到「我上次是怎么答的」—— 而后者往往才是要找的结论。
      // 群聊一定存；私聊跟 ARCHIVE_DM 走，保持和用户消息同一套策略。
      if (isGroup || ARCHIVE_DM) void archiveReply(chatId, final, contextTokens)
      console.log(
        `[完成] ${chatId} ${((Date.now() - t0) / 1000).toFixed(1)}s ${note || ''}` +
          (contextTokens ? ` · 上下文 ${Math.round(contextTokens / 1000)}k` : ''),
      )
    } catch (e) {
      console.error(`[失败] ${chatId}:`, errMsg(e))
      await card.finish(`❌ ${errMsg(e)}`, 'error')
    } finally {
      // 任务结束时若还挂着审批，收掉避免卡死下一条消息
      const p = pendingApprovals.get(chatId)
      if (p) {
        clearTimeout(p.timer)
        pendingApprovals.delete(chatId)
        p.resolve(false)
      }
    }
  })
}

// ── 启动 ──────────────────────────────────────────────────────────────────
await loadState()
await pingDb()
startEmbeddingWorker()

// 上次没收尾的流式卡片：进程崩了或被重启，卡片会永远停在「Claude 正在工作…」，
// 用户不知道该等还是该重发。启动时统一收尾，把话说清楚。
{
  const n = await sweepCards(async (c) => {
    const when = new Date(c.at).toLocaleString('zh-CN', { hour12: false })
    await patchCard(
      c.messageId,
      buildCard(
        `⚠️ 这一轮被中断了（服务在 ${when} 之后重启过），没能跑完。\n\n` +
          '内容没有丢，重新发一次消息就行。',
        { done: true, note: '已中断' },
      ),
    )
  }).catch((e) => {
    console.error('[卡片] 收尾失败:', errMsg(e))
    return 0
  })
  if (n) console.log(`[卡片] 收尾了 ${n} 张上次没跑完的卡片`)
}

if (!BOT_OPEN_ID) {
  try {
    const bot = await getBotInfo()
    BOT_OPEN_ID = bot.openId || ''
    console.log(`🤖 机器人 ${bot.name} open_id=${BOT_OPEN_ID}`)
  } catch (e) {
    console.error('获取机器人 open_id 失败，群聊 @ 判断会退化:', errMsg(e))
  }
}

// chatType 是后加的字段，老的 sessions.json 里没有，而断线补拉要靠它区分群聊/私聊。
// 只回填能确定的那一半：群消息才会入库，所以「库里有这个 chat 的消息」⇒ 群聊。
// 反过来「库里没有」不能推出私聊（可能只是刚拉进群还没人说话），那种就留空，
// 等下一条消息到达时自然写上 —— 宁可补拉暂时不覆盖，也不能把群当私聊处理。
for (const { chatId, chatType } of knownChats({ includeUnknown: true })) {
  if (chatType) continue
  try {
    if ((await recentMessages(chatId, 1)).length) {
      await updateChat(chatId, { chatType: 'group' })
      console.log(`[会话] 回填 ${chatId} = 群聊`)
    }
  } catch {
    /* 没配 PG 就算了，靠下一条消息自愈 */
  }
}

/**
 * 判断一轮「跑完了」的结果其实是失败。返回原因，正常则返回 ''。
 *
 * 为什么需要：run() 只在真抛异常时才 throw，而认证过期、额度耗尽这类
 * 是 CLI 正常返回的一段文本 —— 调度器看不出来，会记成 ok。
 * 实测 carol 的新闻简报连着两天「5 秒完成、状态 ok」，内容却只有一行
 * 「Failed to authenticate: OAuth session expired」，直到她自己来问才发现。
 *
 * 只匹配开头：正文里提到「额度」「认证」是正常的（比如新闻里就有），
 * 而这类系统错误一定是整段回复的全部内容。
 */
function looksBroken(text: string, note?: string): string {
  if (note === 'rate_limited') return '账号额度用完了，这一轮没能执行'
  const head = (text || '').trim().slice(0, 200)
  if (!head) return '没有任何输出'
  const patterns: Array<[RegExp, string]> = [
    [/Failed to authenticate|OAuth session expired/i, '凭证失效，容器里的 Claude 登录态需要修复'],
    [/^⛔ 额度用完了/, '账号额度用完了'],
    [/Invalid API key|authentication_error/i, '认证失败'],
    [/binary exists but failed to launch|native binary at .* exited/i, 'Claude CLI 启动失败'],
    [/^❌ /, '执行出错'],
  ]
  for (const [re, why] of patterns) if (re.test(head)) return why
  return ''
}

/**
 * 存 bot 自己的回复，让 chatlog 检索能覆盖双向对话。
 *
 * message_id 用合成的（`bot-<chatId 尾>-<时间戳>`）—— 流式卡片的 message_id
 * 拿得到，但那是卡片不是消息，混进去反而容易和补拉的去重逻辑打架。
 * 合成 id 保证唯一即可，chat_messages 的主键就是靠它防重。
 *
 * 存之前砍掉卡片脚注那类噪音，只留正文。
 */
async function archiveReply(chatId: string, replyText: string, ctxTokens?: number): Promise<void> {
  const body = (replyText || '').trim()
  // 太短的（「好的」「已发送」）没有检索价值，存了只是噪音。
  // 阈值按「中文算两个字符」折算 —— 直接数长度的话，24 个汉字（已经是完整一句话了）
  // 会被当成太短丢掉。
  const weight = [...body].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)
  if (weight < 30) return
  try {
    await saveMessages(SLUG, [
      {
        messageId: `bot-${chatId.slice(-8)}-${Date.now()}`,
        chatId,
        senderId: BOT_OPEN_ID || 'bot',
        senderName: `${SLUG}(机器人)`,
        msgType: 'text',
        content: body.length > 20000 ? body.slice(0, 20000) + '…（已截断）' : body,
        sentAt: Date.now(),
      },
    ])
  } catch (e) {
    console.error('[存档] bot 回复写入失败:', errMsg(e))
  }
  void ctxTokens
}

// 定时任务：到点主动跑一轮，把结果推到那个会话。
// 复用消息处理的同一套排队 —— 定时任务和用户消息不能并发跑同一个会话。
//
// ⚠️ 会话键用 `${chatId}#task<id>`，不是 chatId：
// 早先两者共用，每次触发都 append 进用户的聊天会话。喝水提醒跑了 101 次，
// 会话文件涨到 18MB，之后每轮普通对话都要把这堆重发一遍 —— 单轮成本从
// $0.25 飙到 $4.49，而且用户的上下文里全是「💧 该喝水啦」。
// fresh 则让每次从头跑：上一次的简报对这一次没有参考价值，留着只是负担。
startScheduler(async (task) => {
  await enqueue(task.chatId, async () => {
    const card = await startStreamCard(task.chatId)
    try {
      const { text, note } = await run(task.chatId, task.prompt, {
        sessionKey: `${task.chatId}#task${task.id}`,
        fresh: true,
        defaultCwd: DEFAULT_CWD,
        slug: SLUG,
        isGroup: task.chatId.startsWith('oc_'),
        onDelta: (d) => card.push(d),
        onTool: (name, input) => card.push(`\n\n> 🔧 **${name}** ${describeTool(name, input)}\n\n`),
        // 定时任务无人值守，不能停在那儿等审批 —— 一律拒绝，让它换个办法
        approve: async () => false,
      })
      const bad = looksBroken(text, note)
      await card.finish(
        `⏰ **${task.title}**\n\n${bad ? `❌ ${bad}\n\n` : ''}${text}`,
        bad ? 'error' : note,
      )
      // run() 不抛异常也可能是失败的 —— 认证过期、额度耗尽都只是「一段文本」。
      // 不抛出去的话调度器记成 ok，任务连着几天没产出也没人知道
      //（carol 的新闻简报就这么静默坏了两天，靠她抱怨才发现）。
      if (bad) throw new Error(bad)
    } catch (e) {
      await card.finish(`⏰ **${task.title}**\n\n❌ ${errMsg(e)}`, 'error')
      throw e // 让调度器记下 last_error
    }
  })
})

// ── 断线补拉 ──────────────────────────────────────────────────────────────
//
// 长连接掉线期间 Lark 推不过来的事件不会丢，但补投走的是它自己的退避时钟
// （实测 ~5 分钟 / ~65 分钟两档），而且不会因为我们重连就立刻冲刷队列。
// 所以重连后主动把这段时间的消息拉回来，别让用户干等。
// 已经处理过的会被 isDuplicate 挡掉，重复拉是安全的。
const PROCESS_START = Date.now()
let disconnectedAt: number | null = null

// 掉线是静默的：真正断开的时刻早于「发现掉线」的时刻，所以往前多回溯一点。
// pong 看门狗把这个差值压在 ping 间隔(120s) + pingTimeout(30s) 以内。
const DETECT_LAG_MS = Number(process.env.LARK_DETECT_LAG_MS || 180_000)

async function catchUp(noticedAt: number): Promise<void> {
  // 起点有两个下界，取更晚的那个：
  //   SEEN_TTL     —— 超出去重窗口的消息重放会造成重复回复
  //   PROCESS_START —— 重启后 seen 是空的，更早的消息可能已被上个进程回过
  const floor = Math.max(PROCESS_START, Date.now() - SEEN_TTL_MS)
  const since = Math.max(noticedAt - DETECT_LAG_MS, floor)
  const chats = knownChats()
  if (!chats.length) return

  let found = 0
  for (const { chatId, chatType } of chats) {
    try {
      const events = await fetchMissedEvents(chatId, since, chatType === 'group')
      for (const ev of events) {
        if (seen.has(ev.message?.message_id)) continue
        found++
        console.log(`[补拉] ${chatId} 追回漏掉的消息 ${ev.message?.message_id}`)
        await onMessage({ ...ev, __catchup: true }).catch((e) =>
          console.error('[补拉] 处理失败:', errMsg(e)),
        )
      }
    } catch (e) {
      console.error(`[补拉] ${chatId} 拉取失败:`, errMsg(e))
    }
  }
  console.log(
    `[补拉] 完成，扫了 ${chats.length} 个会话（回溯到 ${new Date(since).toLocaleTimeString()}），` +
      `追回 ${found} 条`,
  )
}

const ws = makeWSClient({
  onReconnecting: () => {
    // 只记第一次：重连循环里会反复触发
    disconnectedAt ??= Date.now()
    console.warn('[ws] 掉线，开始重连')
  },
  onReconnected: () => {
    const at = disconnectedAt ?? Date.now()
    disconnectedAt = null
    console.log('[ws] 已重连')
    catchUp(at).catch((e) => console.error('[补拉] 失败:', errMsg(e)))
  },
})
// 后台勾了「接收消息」权限就会连带推送已读回执、表情回应这些。用不上，
// 但不注册处理器的话 SDK 每条都 warn 一行，把真正要看的日志淹掉（实测 5 天 232 行）。
const ignore = () => {}

ws.start({
  eventDispatcher: eventDispatcher({
    'im.message.receive_v1': async (data) => {
      try {
        await onMessage(data)
      } catch (e) {
        console.error('处理消息出错:', e)
      }
    },

    // 被拉进群：立刻记下会话类型，这样断线补拉对新群第一条消息就生效，
    // 不用等到有人先发过一句话才知道这是群聊。
    'im.chat.member.bot.added_v1': async (data) => {
      const chatId = data?.chat_id
      if (!chatId) return
      console.log(`[会话] 被拉进群 ${chatId}`)
      await updateChat(chatId, { chatType: 'group' }).catch(() => {})
    },

    'im.message.reaction.created_v1': ignore, // 有人给消息加表情
    'im.message.reaction.deleted_v1': ignore, // 取消表情
    'im.message.message_read_v1': ignore, // 已读回执
  }),
})

console.log(
  `✅ 已启动 | ${CONTAINER_MODE ? '容器模式' : '宿主机模式'} | 默认目录 ${DEFAULT_CWD} | ` +
    `授权用户 ${[...loadUsers().values()].map((s) => `lark-${s}`).join(', ') || '（无，请填 users.json）'}`,
)

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e))
