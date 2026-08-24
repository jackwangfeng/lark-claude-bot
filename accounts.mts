// 多账号池：一个号撞到额度上限就切下一个，到点自动切回。
//
// 凭证就是一份 JSON（accessToken / refreshToken / expiresAt），换账号 = 换文件。
// 池子放在 ~/.lark-agent/accounts/：
//
//   a.json  b.json  c.json    各一份 .credentials.json
//   state.json                当前用哪个 + 各号什么时候恢复
//   .lock                     跨实例互斥（jeff / jeff2 / peter2 是三个进程）
//
// ⚠️ 写回是必须的，不是优化。Claude Code 刷新时会**轮换 refresh token**，
// 旧的随即作废。不把容器里刷新后的凭证写回池，下次切回这个号用的就是
// 已作废的 token，表现为 "OAuth session expired and could not be refreshed"
// —— 这个坑本项目已经踩过两次。
import { readFile, writeFile, readdir, mkdir, open, unlink, stat, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DIR = process.env.LARK_ACCOUNTS_DIR || join(homedir(), '.lark-agent', 'accounts')
const STATE = join(DIR, 'state.json')
const LOCK = join(DIR, '.lock')

/** 锁最多持有这么久；超过认为持锁进程已经死了，可以抢 */
const LOCK_STALE_MS = 30_000

export interface PoolState {
  /** 当前在用的账号名（不带 .json） */
  current?: string
  /** 账号名 → 恢复时间戳。到点前不选它 */
  blocked?: Record<string, number>
  /** 优先级，靠前的优先用。不写则见 PRIMARY */
  order?: string[]
}

/**
 * 主力号。它可用就一直用它，撞上限才退到备用号，恢复了立刻切回来。
 * 这样备用号只在主力号满了的那段时间消耗，平时保持不动。
 */
const PRIMARY = process.env.LARK_ACCOUNT_PRIMARY || 'main'

/**
 * 走团队网关（ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN）时，切号在服务端完成，
 * 本机 ~/.lark-agent/accounts/ 那套 OAuth 文件池不再参与。
 * 有 ANTHROPIC_API_KEY 会让 Claude Code 走按量 API，网关模式必须丢掉它。
 */
export function gatewayMode(): boolean {
  return Boolean(process.env.ANTHROPIC_BASE_URL?.trim() && process.env.ANTHROPIC_AUTH_TOKEN?.trim())
}

/** 池里有哪些号。没有 accounts 目录就返回空 —— 那就是没启用多账号 */
export async function listAccounts(): Promise<string[]> {
  try {
    return (await readdir(DIR))
      .filter((f) => f.endsWith('.json') && f !== 'state.json')
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
  } catch {
    return []
  }
}

/** 按优先级排好的账号列表：主力号在最前，其余按 order，再其余按名字 */
function byPriority(all: string[], order?: string[]): string[] {
  const rank = (n: string): number => {
    if (n === PRIMARY) return -1 // 主力号永远最前
    const i = order?.indexOf(n) ?? -1
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER
  }
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export const enabled = async (): Promise<boolean> => (await listAccounts()).length > 0

async function readState(): Promise<PoolState> {
  try {
    return JSON.parse(await readFile(STATE, 'utf8')) as PoolState
  } catch {
    return {}
  }
}

const writeState = (s: PoolState): Promise<void> =>
  writeFile(STATE, JSON.stringify(s, null, 2))

/**
 * 跨进程互斥。三个 bot 实例共享这个池，同时撞额度会一起来切 ——
 * 不锁的话可能跳过一个号，或者把 state.json 写坏。
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(DIR, { recursive: true })
  for (let i = 0; i < 100; i++) {
    try {
      // wx = 已存在就失败，这就是互斥点
      const fh = await open(LOCK, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      try {
        return await fn()
      } finally {
        await unlink(LOCK).catch(() => {})
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // 持锁进程可能已经崩了，锁会永远留着 —— 超时就抢
      const age = await stat(LOCK)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0)
      if (age > LOCK_STALE_MS) {
        console.warn('[账号池] 锁已过期，强行接管')
        await unlink(LOCK).catch(() => {})
        continue
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('[账号池] 拿锁超时')
}

/** 还没到恢复时间的算不可用 */
const isBlocked = (s: PoolState, name: string, now: number): boolean =>
  (s.blocked?.[name] ?? 0) > now

/**
 * 当前该用哪个号的凭证文件。没启用多账号时返回 null，
 * 调用方退回原来的 ~/.claude/.credentials.json。
 */
export async function currentCredentialPath(): Promise<string | null> {
  if (gatewayMode()) return null
  const all = await listAccounts()
  if (!all.length) return null

  return withLock(async () => {
    const s = await readState()
    const now = Date.now()
    const ranked = byPriority(all, s.order)

    // 每轮都挑优先级最高的可用号 —— 不是「当前号能用就继续用」。
    // 差别在于主力号限流结束后能自动切回来：沿用当前号的话，
    // 一旦退到备用号就再也回不去了，主力号的额度白白闲置。
    const next = ranked.find((n) => !isBlocked(s, n, now))
    if (!next) {
      // 全都撞上限了。挑最早恢复的那个硬着头皮用 —— 让它自己去报错，
      // 总比这里抛异常、整个桥接不响应强。
      const soonest = ranked.reduce((a, b) =>
        (s.blocked?.[a] ?? 0) <= (s.blocked?.[b] ?? 0) ? a : b,
      )
      console.warn(
        `[账号池] 所有号都在限流中，暂用 ${soonest}（${new Date(
          s.blocked?.[soonest] ?? now,
        ).toLocaleString('zh-CN')} 恢复）`,
      )
      // 必须落到 state：currentName() 是 markLimited / writeBack 的依据，
      // 不同步的话会把这个号刷新后的凭证写进另一个号的文件里。
      if (soonest !== s.current) await writeState({ ...s, current: soonest })
      return join(DIR, `${soonest}.json`)
    }

    if (next !== s.current) {
      const back = next === PRIMARY && s.current ? '（主力号已恢复）' : ''
      console.log(`[账号池] 切换 ${s.current ?? '(无)'} → ${next}${back}`)
      await writeState({ ...s, current: next })
    }
    return join(DIR, `${next}.json`)
  })
}

/** 当前号名，纯查询不改状态 */
export async function currentName(): Promise<string | null> {
  const s = await readState()
  return s.current ?? (await listAccounts())[0] ?? null
}

/**
 * 标记某个号撞了上限，并立刻切走。返回换到了哪个号（没得换返回 null）。
 * resetsAt 由 SDK 的 rate_limit_event 给，缺省按 5 小时估。
 */
export async function markLimited(name: string, resetsAt?: number): Promise<string | null> {
  if (gatewayMode()) return null
  const all = await listAccounts()
  if (!all.length) return null

  return withLock(async () => {
    const s = await readState()
    const now = Date.now()
    const until = resetsAt && resetsAt > now ? resetsAt : now + 5 * 3600_000
    const blocked = { ...(s.blocked ?? {}), [name]: until }

    console.warn(
      `[账号池] ${name} 已达额度上限，${new Date(until).toLocaleString('zh-CN')} 恢复`,
    )

    const next = byPriority(all, s.order).find((n) => (blocked[n] ?? 0) <= now)
    await writeState({ ...s, blocked, current: next ?? s.current })
    if (next) console.log(`[账号池] 切换 ${name} → ${next}`)
    else console.error('[账号池] 没有可用的号了，等最早的那个恢复')
    return next ?? null
  })
}

/**
 * 这份凭证 JSON 里到底还有没有 token。
 *
 * 兼容两种外形：{ claudeAiOauth: {...} } 和顶层直接放字段。
 * 解析不了一律当「没有」—— 宁可不写回（保住池里原件），也不要写坏。
 */
function hasTokens(raw: string): boolean {
  try {
    const d = JSON.parse(raw) as Record<string, any>
    const o = (d.claudeAiOauth ?? d) as Record<string, unknown>
    return Boolean(o.accessToken) && Boolean(o.refreshToken)
  } catch {
    return false
  }
}

/**
 * 把容器里刷新过的凭证写回池。每轮结束调一次。
 *
 * 必须做：刷新会轮换 refresh token，旧的立即作废。不写回的话，
 * 池里存的是上一次的 token，下次切回来直接是过期状态。
 */
export async function writeBack(name: string, containerCredPath: string): Promise<void> {
  if (gatewayMode()) return
  const all = await listAccounts()
  if (!all.includes(name)) return
  try {
    const [a, b] = await Promise.all([
      readFile(containerCredPath, 'utf8').catch(() => ''),
      readFile(join(DIR, `${name}.json`), 'utf8').catch(() => ''),
    ])
    if (!a || a === b) return // 没变就别写，省得无谓地动文件

    // ⚠️ 刷新失败时 Claude Code 会把 token 字段抹空，这种「空凭证」绝不能写回 ——
    // 否则一次失败就把池里那份永久毁掉，连人工恢复的余地都没有（原件已被覆盖）。
    // 2026-08-24 踩过：验 acc2 时刷新失败，写回把 acc2.json 的三个 token 全清了，
    // 只能从备份里捞。刷新失败可能只是网络抖动，凭证本身未必坏，更不该销毁。
    if (!hasTokens(a)) {
      console.warn(`[账号池] ${name} 容器里的凭证是空的（多半刷新失败），不写回，保留池里原件`)
      return
    }

    await withLock(async () => {
      await copyFile(containerCredPath, join(DIR, `${name}.json`))
      console.log(`[账号池] ${name} 凭证已更新（刷新后写回）`)
    })
  } catch (e) {
    console.error('[账号池] 写回失败:', (e as Error).message)
  }
}

/** 池子现状，给 /status 用 */
export async function poolStatus(): Promise<string> {
  if (gatewayMode()) {
    return `▶ 网关  ${process.env.ANTHROPIC_BASE_URL!.trim()}`
  }
  const all = await listAccounts()
  if (!all.length) return ''
  const s = await readState()
  const now = Date.now()
  return byPriority(all, s.order)
    .map((n) => {
      const until = s.blocked?.[n] ?? 0
      const mark = n === s.current ? '▶' : ' '
      const st =
        until > now ? `限流至 ${new Date(until).toLocaleString('zh-CN', { hour12: false })}` : '可用'
      return `${mark} ${n}${n === PRIMARY ? '(主力)' : ''}  ${st}`
    })
    .join('\n')
}
