// 向量化：调本地 TEI（bge-m3, 1024 维）。
//
// 嵌入是异步补的，不在消息处理路径上：群消息先落库（embedding = NULL），
// 后台 worker 定期捞出来批量嵌入。这样 TEI 挂了/慢了都不影响收发消息，
// 顶多是新消息暂时搜不到语义相似的。
const ENDPOINT = process.env.LARK_EMBED_URL || 'http://127.0.0.1:8181'
export const EMBED_DIM = 1024

/** TEI 默认 max-client-batch-size 是 32 */
const BATCH = Number(process.env.LARK_EMBED_BATCH || 32)

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH)
    const res = await fetch(`${ENDPOINT}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // bge-m3 支持长文本，但群消息都很短；truncate 防止极端情况报错
      body: JSON.stringify({ inputs: chunk, truncate: true }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`TEI ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const vecs = (await res.json()) as number[][]
    if (vecs.length !== chunk.length) {
      throw new Error(`TEI 返回 ${vecs.length} 条，期望 ${chunk.length}`)
    }
    out.push(...vecs)
  }
  return out
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedTexts([text])
  if (!v) throw new Error('嵌入返回空')
  return v
}

/** 服务是否可用。启动时探一次，不可用就只是没有语义检索，不影响其他功能。 */
export async function pingEmbed(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch {
    return false
  }
}
