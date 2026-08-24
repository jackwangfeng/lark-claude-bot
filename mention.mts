// @ 的解析。抽出来是为了能单测 —— 判错的代价是「群里 @ 了没反应」，
// 而这个故障在日志里几乎不留痕迹，只能靠测试兜。

/**
 * 去掉正文里的 @ 占位符。
 *
 * 原文里 @ 是 "@_user_1 你好" 这种占位符，直接存库会污染检索
 *（搜不到、也读不懂谁在跟谁说话），喂给模型也是噪声。
 *
 * @所有人 不在 mentions 里（它不指向某个人），得单独抠，
 * 不然会留一个裸的 "@_all"。
 */
export function stripMentions(text: string, mentions: Array<{ key?: string }> = []): string {
  let t = text
  for (const m of mentions) if (m.key) t = t.split(m.key).join(' ')
  t = t.split('@_all').join(' ')
  return t.replace(/\s+/g, ' ').trim()
}

/**
 * 消息是不是 @了所有人。
 *
 * ⚠️ @所有人 **不进 mentions 数组** —— 那个数组只装具体的人。光看 mentions
 * 会把「@所有人 + @bot」判成「没 @ 我」，必须回原文里找 `@_all`：
 *   text 消息   content.text 里是裸的 "@_all"
 *   post 消息   content 里是 { tag:'at', user_id:'@_all' } 节点
 *
 * 踩过的坑：08-18 03:17 有人 @所有人 + @bot 发需求，被静默丢了，
 * 14 分钟后群里问「关机了？」。
 */
export function mentionedAll(message: Record<string, any>): boolean {
  let c: unknown
  try {
    c = JSON.parse(message.content)
  } catch {
    return false
  }

  if (message.message_type === 'text') {
    // 用词边界匹配，免得正文里出现 "a@_allb" 这种字符串被误判成 @所有人
    return /(^|\s)@_all(\s|$)/.test((c as Record<string, any>)?.text || '')
  }

  if (message.message_type === 'post') {
    let hit = false
    const walk = (n: unknown): void => {
      if (hit) return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>
        if (o.tag === 'at' && o.user_id === '@_all') {
          hit = true
          return
        }
        Object.values(o).forEach(walk)
      }
    }
    walk(c)
    return hit
  }

  return false
}
