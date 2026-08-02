// 后台补嵌入。独立于消息处理：TEI 挂了只是暂时搜不到语义相似，不影响收发。
import { pendingEmbeddings, saveEmbeddings } from './db.mts'
import { embedTexts, pingEmbed } from './embed.mts'

const INTERVAL_MS = Number(process.env.LARK_EMBED_INTERVAL_MS || 15_000)
const BATCH = Number(process.env.LARK_EMBED_WORKER_BATCH || 200)

let running = false
let consecutiveFailures = 0

async function tick(): Promise<void> {
  if (running) return // 上一轮还没跑完就跳过，别叠加
  running = true
  try {
    const todo = await pendingEmbeddings(BATCH)
    if (!todo.length) {
      consecutiveFailures = 0
      return
    }
    const vecs = await embedTexts(todo.map((t) => t.content))
    const items = todo
      .map((t, i) => ({ id: t.id, vec: vecs[i] }))
      .filter((x): x is { id: string; vec: number[] } => Array.isArray(x.vec))
    const n = await saveEmbeddings(items)
    console.log(`[嵌入] 补了 ${n} 条，剩 ${todo.length === BATCH ? '还有更多' : '0'}`)
    consecutiveFailures = 0
  } catch (e) {
    consecutiveFailures++
    // 前几次失败正常打日志，之后降噪 —— TEI 长时间不可用时不该刷屏
    if (consecutiveFailures <= 3 || consecutiveFailures % 20 === 0) {
      console.error(`[嵌入] 失败(第 ${consecutiveFailures} 次):`, (e as Error).message)
    }
  } finally {
    running = false
  }
}

export function startEmbeddingWorker(): void {
  void (async () => {
    const ok = await pingEmbed()
    console.log(
      ok
        ? '[嵌入] TEI 可用，后台补向量已启动'
        : '[嵌入] TEI 暂不可用 —— 消息照常存，等服务起来会自动补上',
    )
  })()
  const t = setInterval(() => void tick(), INTERVAL_MS)
  t.unref() // 别因为这个定时器阻止进程退出
}
