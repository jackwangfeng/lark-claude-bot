// Lark ↔ Claude 桥接：收消息 → 鉴权/去重/命令 → 排队 → agent.run → 流式卡片
import {
  makeWSClient, eventDispatcher, sendText, startStreamCard, react, getBotInfo,
  getRecentUserText, getMessage, fetchGroupSince, renderMessages, senderName,
  fetchMissedEvents,
} from './lark.mts'
import { saveMessages, pingDb, recentMessages } from './db.mts'
import { startEmbeddingWorker } from './embed-worker.mts'
import { startScheduler } from './scheduler.mts'
import {
  loadState, getChat, updateChat, run, isRunning, abort, knownChats,
  CONTAINER_MODE, CONTAINER_DEFAULT_CWD, ensureContainer, dirExistsInContainer,
} from './agent.mts'
import { existsSync, statSync, readFileSync } from 'node:fs'
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

function stripMentions(text: string, mentions: Array<{ key?: string }> = []): string {
  let t = text
  for (const m of mentions) if (m.key) t = t.split(m.key).join(' ')
  return t.replace(/\s+/g, ' ').trim()
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
        ].join('\n'),
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

  if (isDuplicate(message.message_id)) return

  // 记下会话类型，断线重连补拉时要用（拉历史的接口不返回 chat_type）
  const known = getChat(chatId, DEFAULT_CWD)
  if (known.chatType !== (isGroup ? 'group' : 'p2p')) {
    updateChat(chatId, { chatType: isGroup ? 'group' : 'p2p' }).catch(() => {})
  }

  const mentions = message.mentions || []
  const users = loadUsers()

  // 群消息一律先存 —— 应用有 im:message.group_msg:readonly，没被 @ 的消息也会推过来。
  // 存储和「要不要回应」是两件事：存是为了长期记忆，回应才看 @。
  // 放在授权检查之前：群里所有人的发言都是上下文，不该因为发言人不在白名单就丢掉。
  if (isGroup) {
    // 存清理过 mention 占位符的文本：原文里是 "@_user_1 你好"，
    // 存进去会污染检索（搜不到、也读不懂谁在跟谁说话）
    const body = stripMentions(extractText(message), mentions).trim()
    if (body && String(openId).startsWith('ou_')) {
      saveMessages(SLUG, [
        {
          messageId: message.message_id,
          chatId,
          senderId: openId,
          senderName: await senderName(chatId, openId),
          msgType: message.message_type ?? 'text',
          content: body,
          sentAt: Number(message.create_time) || Date.now(),
        },
      ]).catch((e) => console.error('[存档] 写入失败:', errMsg(e)))
    }
  }

  // 授权模型按会话类型分：
  //   私聊 —— 必须在 users.json 里（可用范围在私聊场景是硬约束，这里再兜一层）
  //   群聊 —— 群成员名单即授权名单，任何人 @ 都服务；但群成员能进的只有这个群自己的容器
  if (isGroup) {
    if (!mentionedBot(mentions)) return
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
    return
  }

  const raw = extractText(message)
  let text = stripMentions(raw, mentions)

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
      const { text: final, note } = await run(chatId, prompt, {
        defaultCwd: DEFAULT_CWD,
        slug: SLUG,
        isGroup,
        onDelta: (d) => card.push(d),
        onTool: (name, input) => {
          // 免审批模式下这是唯一的留痕，落 journal 便于事后追查
          console.log(`[工具] ${chatId} ${name} ${JSON.stringify(input).slice(0, 300)}`)
          card.push(`\n\n> 🔧 **${name}** ${describeTool(name, input)}\n\n`)
        },
        approve: (name, input) => askApproval(chatId, name, input),
      })
      await card.finish(final, note)
      console.log(`[完成] ${chatId} ${((Date.now() - t0) / 1000).toFixed(1)}s ${note || ''}`)
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

// 定时任务：到点主动跑一轮，把结果推到那个会话。
// 复用消息处理的同一套排队 —— 定时任务和用户消息不能并发跑同一个会话。
startScheduler(async (task) => {
  await enqueue(task.chatId, async () => {
    const card = await startStreamCard(task.chatId)
    try {
      const { text, note } = await run(task.chatId, task.prompt, {
        defaultCwd: DEFAULT_CWD,
        slug: SLUG,
        isGroup: task.chatId.startsWith('oc_'),
        onDelta: (d) => card.push(d),
        onTool: (name, input) => card.push(`\n\n> 🔧 **${name}** ${describeTool(name, input)}\n\n`),
        // 定时任务无人值守，不能停在那儿等审批 —— 一律拒绝，让它换个办法
        approve: async () => false,
      })
      await card.finish(`⏰ **${task.title}**\n\n${text}`, note)
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
