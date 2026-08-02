// 定时任务调度器。
//
// 为什么不用 SDK 自带的 CronCreate：那是「会话级」的 —— 唤醒的是发起它的那个
// SDK 会话。而桥接是「一条消息一个 query()」，跑完进程就结束，会话早没了，
// cron 醒来时没有东西可唤醒。而且 agent 也不知道自己接在 Lark 上、往哪个 chat 发。
//
// 所以分工是：调度和推送归桥接，理解意图和执行内容归 agent。
import { activeTasks, markTaskRun, type ScheduledTask } from './db.mts'

/** 五段式 cron：分 时 日 月 周。支持 * / 数字 / 逗号列表 / a-b 区间 / *\/n 步长 */
function fieldMatches(spec: string, value: number): boolean {
  for (const part of spec.split(',')) {
    if (part === '*') return true
    const step = part.match(/^(\*|\d+-\d+)\/(\d+)$/)
    if (step) {
      const n = Number(step[2])
      if (n <= 0) continue
      if (step[1] === '*') {
        if (value % n === 0) return true
      } else {
        const [a, b] = step[1]!.split('-').map(Number)
        if (value >= a! && value <= b! && (value - a!) % n === 0) return true
      }
      continue
    }
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      if (value >= Number(range[1]) && value <= Number(range[2])) return true
      continue
    }
    if (Number(part) === value) return true
  }
  return false
}

export function cronMatches(cron: string, d: Date): boolean {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return false
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string]
  return (
    fieldMatches(min, d.getMinutes()) &&
    fieldMatches(hour, d.getHours()) &&
    fieldMatches(dom, d.getDate()) &&
    fieldMatches(mon, d.getMonth() + 1) &&
    fieldMatches(dow, d.getDay())
  )
}

/** 校验，创建任务前用 —— 让 agent 拿到明确的错误而不是静默不执行 */
export function validateCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return '必须是五段式：分 时 日 月 周，例如 "0 9 * * *"'
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  for (let i = 0; i < 5; i++) {
    const spec = f[i]!
    if (!/^[\d*,\-/]+$/.test(spec)) return `第 ${i + 1} 段 "${spec}" 含非法字符`
    for (const n of spec.match(/\d+/g) ?? []) {
      const v = Number(n)
      const [lo, hi] = ranges[i]!
      if (v < lo || v > hi) return `第 ${i + 1} 段 "${spec}" 超出范围 ${lo}-${hi}`
    }
  }
  return null
}

type RunTask = (t: ScheduledTask) => Promise<void>

const SLUG = process.env.LARK_SLUG || 'default'

/**
 * 每分钟扫一次。用「上次执行是否在本分钟内」去重 ——
 * 进程重启、时钟微调都可能让同一分钟被扫到两次。
 */
export function startScheduler(runTask: RunTask): void {
  let busy = false

  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const now = new Date()
      const tasks = await activeTasks(SLUG)
      for (const t of tasks) {
        if (!cronMatches(t.cron, now)) continue
        // 同一分钟内已经跑过就跳过
        if (t.lastRunAt && Math.floor(t.lastRunAt / 60_000) === Math.floor(now.getTime() / 60_000)) {
          continue
        }
        console.log(`[定时] 触发 #${t.id} ${t.title}`)
        // 先标记再执行：任务本身可能跑很久，标记晚了会被下一分钟重复触发
        await markTaskRun(t.id, 'running')
        try {
          await runTask(t)
          await markTaskRun(t.id, 'ok')
          console.log(`[定时] 完成 #${t.id}`)
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e)
          await markTaskRun(t.id, 'error', msg)
          console.error(`[定时] 失败 #${t.id}: ${msg}`)
        }
      }
    } catch (e) {
      console.error('[定时] 扫描出错:', (e as Error)?.message ?? e)
    } finally {
      busy = false
    }
  }

  // 对齐到整分钟再开始，避免在 59.9 秒触发、下一秒又匹配一次
  const msToNextMinute = 60_000 - (Date.now() % 60_000)
  setTimeout(() => {
    void tick()
    const timer = setInterval(() => void tick(), 60_000)
    timer.unref()
  }, msToNextMinute).unref()

  console.log('[定时] 调度器已启动（每分钟检查一次）')
}
