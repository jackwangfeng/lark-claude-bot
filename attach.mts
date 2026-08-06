// 附件合并的纯逻辑。
//
// 单独一个文件是为了能被测试 import 而不启动整个桥接 ——
// 从 index.mts 里 import 会连带起一个 WS 客户端，用同一份凭证抢真实服务的事件。

export interface SavedFile {
  /** 给 Claude 看的路径（容器模式下是容器内路径） */
  path: string
  kind: string
}

export type AttachPlan =
  /** 攒着，起/续定时器，这一轮先不跑 */
  | { action: 'wait'; files: SavedFile[] }
  /** 立刻跑，带上这些附件（含之前攒的） */
  | { action: 'go'; files: SavedFile[] }
  /** 跟附件无关，原样往下走，缓冲区别动 */
  | { action: 'pass' }

/**
 * 决定这条消息该不该等后面的附件。
 *
 * Lark 是「一张图一条消息」，连发 3 张就是 3 个事件。不合并会触发 3 轮 Claude：
 * 又慢又贵，而且模型每轮只看得到一张，没法对比着说。
 *
 * 分支容易想漏的是「先发几张图、再打一句话」—— 那句话本身不带附件，
 * 但必须把攒着的图一起带走，否则文字先跑一轮、图片过会儿又跑一轮。
 */
export function planAttach(a: {
  /** 已攒着的 */
  pending?: SavedFile[]
  /** 这条消息带来的 */
  incoming: SavedFile[]
  hasText: boolean
  /** 斜杠命令不参与合并，拼进 /status 只会让它解析失败 */
  isCmd: boolean
}): AttachPlan {
  const pending = a.pending ?? []
  if (a.isCmd) return { action: 'pass' }
  if (!pending.length && !a.incoming.length) return { action: 'pass' }
  const files = [...pending, ...a.incoming]
  return a.hasText ? { action: 'go', files } : { action: 'wait', files }
}
