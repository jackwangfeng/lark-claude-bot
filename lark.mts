// Lark API 封装：发消息、流式更新卡片、表情回应、下载附件
import lark from '@larksuiteoapi/node-sdk'
import { writeFile } from 'node:fs/promises'

const { LARK_APP_ID, LARK_APP_SECRET } = process.env
if (!LARK_APP_ID || !LARK_APP_SECRET) {
  console.error('缺少 LARK_APP_ID / LARK_APP_SECRET')
  process.exit(1)
}

// domain 必须是 Lark（国际版）；国内飞书用 lark.Domain.Feishu
export const client = new lark.Client({
  appId: LARK_APP_ID!,
  appSecret: LARK_APP_SECRET!,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Lark,
})

export function makeWSClient() {
  return new lark.WSClient({
    appId: LARK_APP_ID!,
    appSecret: LARK_APP_SECRET!,
    domain: lark.Domain.Lark,
    loggerLevel: lark.LoggerLevel.info,
  })
}

export const eventDispatcher = (handlers: Record<string, (data: any) => unknown>) => new lark.EventDispatcher({}).register(handlers)

// 机器人自身的 open_id —— 群里判断「是不是 @ 我」要用。
// 只要应用开了机器人能力就能调，不需要额外权限，所以不用手配环境变量。
export async function getBotInfo() {
  const r = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
  const b = (r as any)?.bot ?? (r as any)?.data?.bot ?? r
  return { openId: b?.open_id, name: b?.app_name }
}

// 从消息体里抠出纯文本。历史接口返回的是 msg_type + body.content，
// 事件推送是 message_type + content，字段名不一样，这里统一处理。
export function textOf(msgType: string | undefined, content: string | undefined): string {
  let c
  try {
    c = JSON.parse(content || '{}')
  } catch {
    return ''
  }
  if (msgType === 'text') return c.text || ''
  if (msgType === 'post') {
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

// 取某条消息（用于「回复某条消息并 @ 机器人」的场景）
export async function getMessage(messageId: string) {
  const r = await client.im.message.get({ path: { message_id: messageId } })
  const m = (r?.data?.items ?? [])[0]
  if (!m) return null
  return { text: textOf(m.msg_type, m.body?.content), senderId: m.sender?.id, messageId: m.message_id }
}

// 群成员名字缓存：进程级，群成员变动不频繁，没必要每轮拉
const memberCache = new Map<string, Map<string, string>>()

async function memberNames(chatId: string): Promise<Map<string, string>> {
  const cached = memberCache.get(chatId)
  if (cached) return cached
  const m = new Map()
  try {
    const r = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100 },
    })
    for (const it of r?.data?.items || []) if (it.member_id) m.set(it.member_id, it.name || '')
  } catch {
    // 没有 im:chat.members:read 权限就退化成用 ID 后 4 位，不影响主流程
  }
  memberCache.set(chatId, m)
  return m
}

/**
 * 往回翻页拉群消息，直到遇到 sinceId（上次已处理的最后一条）。
 *
 * 为什么要翻页：机器人只在被 @ 时才收到群消息，两次 @ 之间的对话它完全没见过。
 * 只拉一页的话，隔了几天再 @ 就会丢掉中间所有内容。
 *
 * 返回按时间正序排列的「人发的、有文字的」消息。
 */
export interface RawGroupMessage {
  id: string
  sender: string
  text: string
  at: number
}

export async function fetchGroupSince(
  chatId: string,
  sinceId?: string | null,
  { maxPages = 10, pageSize = 50 }: { maxPages?: number; pageSize?: number } = {},
): Promise<{ messages: RawGroupMessage[]; newestId: string | null }> {
  const out = []
  let pageToken
  let newestId = null
  let hitSince = false

  for (let i = 0; i < maxPages && !hitSince; i++) {
    const r = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: pageSize,
        sort_type: 'ByCreateTimeDesc',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })
    const items = r?.data?.items || []
    if (!newestId) newestId = items[0]?.message_id || null

    for (const m of items) {
      if (sinceId && m.message_id === sinceId) {
        hitSince = true
        break
      }
      const sender = String(m.sender?.id || '')
      if (!sender.startsWith('ou_')) continue // 机器人自己发的卡片跳过
      const text = textOf(m.msg_type, m.body?.content).trim()
      if (!text) continue
      if (!m.message_id) continue
      out.push({
        id: m.message_id,
        sender,
        text,
        at: Number(m.create_time) || Date.now(),
      })
    }

    if (!r?.data?.has_more) break
    pageToken = r?.data?.page_token
    if (!pageToken) break
    // 第一次运行（没有 sinceId）不要把整个群史拉下来
    if (!sinceId) break
  }

  out.reverse() // 时间正序
  return { messages: out, newestId }
}

/** 取单个发言人的名字，用于实时存档。取不到返回 undefined，让 DB 存 null。 */
export async function senderName(chatId: string, openId: string): Promise<string | undefined> {
  const names = await memberNames(chatId)
  return names.get(openId)
}

/** 把消息渲染成「名字: 内容」，名字取不到就用 ID 后 4 位 */
export async function renderMessages(chatId: string, messages: RawGroupMessage[]): Promise<string[]> {
  const names = await memberNames(chatId)
  return messages.map((m) => `${names.get(m.sender) ?? `用户${m.sender.slice(-4)}`}: ${m.text}`)
}

// 取本会话里最近一条「人发的、有文字的」消息，跳过机器人自己发的卡片
export async function getRecentUserText(
  chatId: string,
  excludeMessageId?: string,
  limit = 10,
): Promise<{ text: string; senderId: string; messageId: string } | null> {
  const r = await client.im.message.list({
    params: {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: limit,
      sort_type: 'ByCreateTimeDesc',
    },
  })
  for (const m of r?.data?.items ?? []) {
    if (m.message_id === excludeMessageId) continue
    if (!String(m.sender?.id || '').startsWith('ou_')) continue // 机器人发的跳过
    const text = textOf(m.msg_type, m.body?.content).trim()
    if (text && m.sender?.id && m.message_id)
      return { text, senderId: m.sender.id, messageId: m.message_id }
  }
  return null
}

const CARD_LIMIT = 3800

function clip(text: string): string {
  if (text.length <= CARD_LIMIT) return text
  // 保留尾部——正在生成时用户最关心最新内容
  return '…（前文已截断）\n\n' + text.slice(-CARD_LIMIT)
}

export function buildCard(text: string, { done = false, note = '' }: { done?: boolean; note?: string } = {}) {
  const body = text.trim() || (done ? '(无输出)' : '思考中…')
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: clip(body) }]
  if (note) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note }] })
  }
  return {
    config: { wide_screen_mode: true, update_multi: true }, // update_multi 必须为 true 才能后续 patch
    header: {
      template: done ? 'green' : 'blue',
      title: { tag: 'plain_text', content: done ? 'Claude' : 'Claude 正在工作…' },
    },
    elements,
  }
}

export async function sendText(chatId: string, text: string): Promise<string | undefined> {
  const r = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
  })
  return r?.data?.message_id
}

export async function sendCard(chatId: string, card: object): Promise<string | undefined> {
  const r = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
  })
  return r?.data?.message_id
}

export async function patchCard(messageId: string, card: object): Promise<void> {
  await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  })
}

export async function react(messageId: string, emoji = 'THUMBSUP'): Promise<void> {
  try {
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    })
  } catch {
    /* 表情失败无所谓 */
  }
}

// 下载消息里的图片/文件到本地，返回路径
export async function downloadResource(messageId: string, fileKey: string, type: string, destPath: string): Promise<string> {
  const r = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type }, // 'image' | 'file'
  })
  const chunks = []
  for await (const c of r.getReadableStream()) chunks.push(c)
  await writeFile(destPath, Buffer.concat(chunks))
  return destPath
}

/**
 * 流式卡片：先发一张，之后节流 patch。
 * 用法：const s = await startStreamCard(chatId); s.push('文本'); await s.finish('最终文本', '耗时 3s')
 */
export async function startStreamCard(chatId: string, minIntervalMs = 1200) {
  let text = ''
  let messageId = await sendCard(chatId, buildCard(''))
  let lastSent = 0
  let timer: NodeJS.Timeout | null = null
  let closed = false

  async function flush(done = false, note = ''): Promise<void> {
    if (!messageId) return
    lastSent = Date.now()
    try {
      await patchCard(messageId, buildCard(text, { done, note }))
    } catch (e) {
      console.error('patchCard 失败:', (e as Error)?.message ?? e)
    }
  }

  return {
    get messageId() {
      return messageId
    },
    push(delta: string) {
      if (closed) return
      text += delta
      if (timer) return
      const wait = Math.max(0, minIntervalMs - (Date.now() - lastSent))
      timer = setTimeout(() => {
        timer = null
        flush(false)
      }, wait)
    },
    async finish(finalText?: string | null, note?: string) {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (finalText != null && finalText.trim()) text = finalText
      await flush(true, note)
    },
  }
}
