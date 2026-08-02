// 群聊消息存档 —— 落 PG。
//
// 为什么不落文件：PG 天然幂等（message_id 主键）、能按发言人/时间范围查、
// 以后加一列 vector 就能上 RAG，不用改结构。
//
// Node 24 原生剥离类型，这个文件直接 `import './db.ts'` 就能跑，不需要构建。
import pg from 'pg'

export interface ChatMessage {
  messageId: string
  chatId: string
  senderId: string
  senderName?: string | null
  msgType: string
  content: string
  /** 毫秒时间戳 */
  sentAt: number
}

export interface StoredMessage extends ChatMessage {
  botSlug: string
}

// 没配就是没有长期记忆 —— 群聊照常工作，只是不落库、不能检索历史。
// 不给默认值：连错库比连不上更难查。
const DSN = process.env.LARK_PG_DSN || ''

export const dbEnabled = Boolean(DSN)

let pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!DSN) throw new Error('未配置 LARK_PG_DSN，群聊长期记忆不可用')
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DSN,
      max: 4,
      // 数据库挂了不能把桥接拖死：连不上就快速失败，调用方吞掉异常继续
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: 10_000,
    })
    pool.on('error', (e: Error) => console.error('[db] 连接池错误:', e.message))
  }
  return pool
}

/** 启动时验证一次，连不上就明确报出来，而不是等第一条群消息才发现 */
export async function pingDb(): Promise<boolean> {
  if (!DSN) {
    console.log('[db] 未配置 LARK_PG_DSN —— 群聊长期记忆已禁用')
    return false
  }
  try {
    const r = await getPool().query<{ n: number }>('select count(*)::int as n from chat_messages')
    console.log(`[db] 已连接，现有 ${r.rows[0]?.n ?? 0} 条群消息`)
    return true
  } catch (e) {
    console.error('[db] 连不上:', (e as Error).message)
    return false
  }
}

/**
 * 批量写入。按 message_id 幂等 —— 重复处理同一批消息不会产生重复行，
 * 所以「往回翻页补齐」可以放心重叠，不用精确控制边界。
 * @returns 实际新增的条数
 */
export async function saveMessages(botSlug: string, msgs: ChatMessage[]): Promise<number> {
  if (!DSN || !msgs.length) return 0
  const values: unknown[] = []
  const rows = msgs.map((m, i) => {
    const b = i * 8
    values.push(
      m.messageId,
      m.chatId,
      botSlug,
      m.senderId,
      m.senderName ?? null,
      m.msgType,
      m.content,
      new Date(m.sentAt),
    )
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`
  })
  const sql =
    'INSERT INTO chat_messages ' +
    '(message_id, chat_id, bot_slug, sender_id, sender_name, msg_type, content, sent_at) VALUES ' +
    rows.join(',') +
    ' ON CONFLICT (message_id) DO NOTHING'
  const r = await getPool().query(sql, values)
  return r.rowCount ?? 0
}

/** 某个群最近 N 条，返回时间正序 */
export async function recentMessages(chatId: string, limit = 30): Promise<StoredMessage[]> {
  if (!DSN) return []
  const r = await getPool().query(
    `SELECT message_id, chat_id, bot_slug, sender_id, sender_name, msg_type, content,
            extract(epoch from sent_at) * 1000 AS sent_ms
       FROM chat_messages WHERE chat_id = $1
       ORDER BY sent_at DESC LIMIT $2`,
    [chatId, limit],
  )
  return r.rows
    .map((x: Record<string, unknown>) => ({
      messageId: x.message_id as string,
      chatId: x.chat_id as string,
      botSlug: x.bot_slug as string,
      senderId: x.sender_id as string,
      senderName: x.sender_name as string | null,
      msgType: x.msg_type as string,
      content: x.content as string,
      sentAt: Number(x.sent_ms),
    }))
    .reverse()
}

const rowToMsg = (x: Record<string, unknown>): StoredMessage => ({
  messageId: x.message_id as string,
  chatId: x.chat_id as string,
  botSlug: x.bot_slug as string,
  senderId: x.sender_id as string,
  senderName: x.sender_name as string | null,
  msgType: x.msg_type as string,
  content: x.content as string,
  sentAt: Number(x.sent_ms),
})

/** 取还没嵌入的消息，供后台 worker 批量补 */
export async function pendingEmbeddings(limit = 200): Promise<Array<{ id: string; content: string }>> {
  if (!DSN) return []
  const r = await getPool().query(
    `SELECT message_id, content FROM chat_messages
      WHERE embedding IS NULL ORDER BY created_at LIMIT $1`,
    [limit],
  )
  return r.rows.map((x: Record<string, unknown>) => ({
    id: x.message_id as string,
    content: x.content as string,
  }))
}

/** 回写向量。一条一条 update —— 批量 CASE WHEN 拼串反而更容易出错，量也不大。 */
export async function saveEmbeddings(items: Array<{ id: string; vec: number[] }>): Promise<number> {
  if (!items.length) return 0
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const { id, vec } of items) {
      // pgvector 接受 '[1,2,3]' 这种字符串字面量
      await client.query('UPDATE chat_messages SET embedding = $1::vector WHERE message_id = $2', [
        JSON.stringify(vec),
        id,
      ])
    }
    await client.query('COMMIT')
    return items.length
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 语义检索。和关键词检索互补：
 * 关键词答「谁提过 SeeSaw」，语义答「谁说过跟竞品分析有关的事」。
 */
export async function semanticSearch(
  chatId: string,
  queryVec: number[],
  limit = 20,
): Promise<Array<StoredMessage & { distance: number }>> {
  const r = await getPool().query(
    `SELECT message_id, chat_id, bot_slug, sender_id, sender_name, msg_type, content,
            extract(epoch from sent_at) * 1000 AS sent_ms,
            embedding <=> $2::vector AS distance
       FROM chat_messages
      WHERE chat_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [chatId, JSON.stringify(queryVec), limit],
  )
  return r.rows.map((x: Record<string, unknown>) => ({
    ...rowToMsg(x),
    distance: Number(x.distance),
  }))
}

// ── 定时任务 ──────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: number
  chatId: string
  botSlug: string
  createdBy: string | null
  title: string
  /** 到点后喂给 agent 的指令 */
  prompt: string
  /** 五段式 cron，本地时区 */
  cron: string
  enabled: boolean
  lastRunAt: number | null
  lastStatus: string | null
  lastError: string | null
}

const rowToTask = (x: Record<string, unknown>): ScheduledTask => ({
  id: Number(x.id),
  chatId: x.chat_id as string,
  botSlug: x.bot_slug as string,
  createdBy: x.created_by as string | null,
  title: x.title as string,
  prompt: x.prompt as string,
  cron: x.cron as string,
  enabled: Boolean(x.enabled),
  lastRunAt: x.last_run_ms ? Number(x.last_run_ms) : null,
  lastStatus: x.last_status as string | null,
  lastError: x.last_error as string | null,
})

const TASK_COLS = `id, chat_id, bot_slug, created_by, title, prompt, cron, enabled,
  extract(epoch from last_run_at) * 1000 AS last_run_ms, last_status, last_error`

export async function createTask(t: {
  chatId: string
  botSlug: string
  createdBy?: string | null
  title: string
  prompt: string
  cron: string
}): Promise<number> {
  const r = await getPool().query(
    `INSERT INTO scheduled_tasks (chat_id, bot_slug, created_by, title, prompt, cron)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [t.chatId, t.botSlug, t.createdBy ?? null, t.title, t.prompt, t.cron],
  )
  return Number(r.rows[0]?.id)
}

/** 某个会话的任务列表（给 agent 看的） */
export async function listTasks(chatId: string): Promise<ScheduledTask[]> {
  if (!DSN) return []
  const r = await getPool().query(
    `SELECT ${TASK_COLS} FROM scheduled_tasks WHERE chat_id = $1 ORDER BY id`,
    [chatId],
  )
  return r.rows.map(rowToTask)
}

/** 调度器用：本实例所有启用的任务 */
export async function activeTasks(botSlug: string): Promise<ScheduledTask[]> {
  if (!DSN) return []
  const r = await getPool().query(
    `SELECT ${TASK_COLS} FROM scheduled_tasks WHERE bot_slug = $1 AND enabled`,
    [botSlug],
  )
  return r.rows.map(rowToTask)
}

export async function deleteTask(chatId: string, id: number): Promise<boolean> {
  // 带 chat_id 是防越权：一个会话只能删自己的任务
  const r = await getPool().query('DELETE FROM scheduled_tasks WHERE id = $1 AND chat_id = $2', [
    id,
    chatId,
  ])
  return (r.rowCount ?? 0) > 0
}

export async function setTaskEnabled(chatId: string, id: number, enabled: boolean): Promise<boolean> {
  const r = await getPool().query(
    'UPDATE scheduled_tasks SET enabled = $3 WHERE id = $1 AND chat_id = $2',
    [id, chatId, enabled],
  )
  return (r.rowCount ?? 0) > 0
}

/** 记录一次执行结果。last_run_at 同时是「这一分钟已经跑过」的去重依据。 */
export async function markTaskRun(id: number, status: string, error?: string): Promise<void> {
  await getPool().query(
    'UPDATE scheduled_tasks SET last_run_at = now(), last_status = $2, last_error = $3 WHERE id = $1',
    [id, status, error?.slice(0, 500) ?? null],
  )
}

/** 关键词检索。中文没装 zhparser，用 ILIKE + trigram 索引兜住 */
export async function searchMessages(
  chatId: string,
  keyword: string,
  limit = 30,
): Promise<StoredMessage[]> {
  const r = await getPool().query(
    `SELECT message_id, chat_id, bot_slug, sender_id, sender_name, msg_type, content,
            extract(epoch from sent_at) * 1000 AS sent_ms
       FROM chat_messages
      WHERE chat_id = $1 AND content ILIKE '%' || $2 || '%'
      ORDER BY sent_at DESC LIMIT $3`,
    [chatId, keyword, limit],
  )
  return r.rows.map((x: Record<string, unknown>) => ({
    messageId: x.message_id as string,
    chatId: x.chat_id as string,
    botSlug: x.bot_slug as string,
    senderId: x.sender_id as string,
    senderName: x.sender_name as string | null,
    msgType: x.msg_type as string,
    content: x.content as string,
    sentAt: Number(x.sent_ms),
  }))
}
