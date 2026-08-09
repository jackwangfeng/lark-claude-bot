// 在途卡片登记表：进程没了也能把卡片收尾。
//
// 流式卡片先发一张空的，之后不断 patch，最后一次 patch 标记完成。中间进程要是
// 挂了 / 被重启，那张卡就永远停在「Claude 正在工作…」—— 用户不知道该等还是重发。
// 实测踩过：重启掐断了 masa 那轮，他那边卡片一直转圈。
//
// 所以落盘而不是放内存：内存表在 SIGKILL 时一起没，正是最需要它的场景。
// 每个实例一份，和 sessions.json 放一起。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SLUG = process.env.LARK_SLUG || 'default'
const FILE = join(homedir(), '.lark-agent', SLUG, 'pending-cards.json')

export interface PendingCard {
  chatId: string
  messageId: string
  /** 开卡时间，用于告诉用户「那轮是什么时候的」 */
  at: number
  /** 简短标题，让收尾提示能说清是哪一轮 */
  label?: string
}

type Table = Record<string, PendingCard>

async function load(): Promise<Table> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Table
  } catch {
    return {}
  }
}

// 写临时文件再 rename —— 直接覆盖写的话，进程正好死在写一半会留下坏 JSON，
// 下次启动读不出来，等于登记表白做了
async function save(t: Table): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  await writeFile(tmp, JSON.stringify(t, null, 2))
  await rename(tmp, FILE)
}

export async function register(c: PendingCard): Promise<void> {
  const t = await load()
  t[c.messageId] = c
  await save(t)
}

export async function unregister(messageId: string): Promise<void> {
  const t = await load()
  if (!t[messageId]) return
  delete t[messageId]
  await save(t)
}

/**
 * 启动时调用：把上次没收尾的卡片全部标记成中断。
 * @param finish 收尾回调，交给调用方去 patch（这里不 import lark.mts，免得循环依赖）
 */
export async function sweep(
  finish: (card: PendingCard) => Promise<void>,
): Promise<number> {
  const t = await load()
  const cards = Object.values(t)
  if (!cards.length) return 0
  for (const c of cards) {
    try {
      await finish(c)
    } catch (e) {
      console.error(`[卡片] 收尾 ${c.messageId} 失败:`, (e as Error).message)
    }
  }
  await save({})
  return cards.length
}
