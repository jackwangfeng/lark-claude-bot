// @ 解析的单测：node test-mention.mts
//
// 判错的代价是「群里 @ 了，bot 没反应」，而这个故障在日志里几乎不留痕迹 ——
// 08-18 03:17 那次丢消息，整段 journal 里只有一行 [嵌入]，查了很久才定位。
// 所以这里的 fixture 全部是从 Lark API 拉回来的**真实报文**，不是手写的。
import assert from 'node:assert'
import { mentionedAll, stripMentions } from './mention.mts'

let pass = 0
let fail = 0

function t(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    pass++
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`)
    fail++
  }
}

// 真实报文：08-18 03:17:46 om_x100b6701ab6ac8a0e2c09a86ee60528
// 「@所有人 @jeff-bot2 请按照以上框架 做一份SeeSaw产品PRD」—— 就是被静默丢掉的那条。
// 注意它同时带 content 和 content_v2 两份，遍历必须两份都能命中。
const REAL_AT_ALL_POST = {
  message_type: 'post',
  content: JSON.stringify({
    title: '',
    content: [
      [
        { tag: 'at', user_id: '@_all', user_name: '所有人', style: [] },
        { tag: 'text', text: ' ', style: [] },
        { tag: 'at', user_id: '@_user_1', user_name: 'jeff-bot2', style: [] },
      ],
      [{ tag: 'text', text: 'SeeSaw V2基本框架', style: ['bold'] }],
      [{ tag: 'text', text: '请按照以上框架 做一份SeeSaw产品PRD', style: [] }],
    ],
    content_v2: [
      [
        { tag: 'at', user_id: '@_all', user_name: '所有人', style: [] },
        { tag: 'at', user_id: '@_user_1', user_name: 'jeff-bot2', style: [] },
      ],
    ],
  }),
}

// 真实报文：08-18 03:31:49 —— 只 @ 了 bot，没 @所有人。这条当时是正常响应的，
// 修完之后它必须还是走 mentionedBot 那条路，不能被 mentionedAll 顺手认领。
const REAL_AT_BOT_TEXT = {
  message_type: 'text',
  content: JSON.stringify({ text: '@_user_1 关机了？' }),
}

console.log('mentionedAll:')

t('真实报文：@所有人 + @bot 的 post → 触发（这是踩过的那个坑）', () => {
  assert.equal(mentionedAll(REAL_AT_ALL_POST), true)
})

t('真实报文：只 @bot 的 text → 不由 @所有人 触发（交给 mentionedBot 判）', () => {
  assert.equal(mentionedAll(REAL_AT_BOT_TEXT), false)
})

t('text 里的 @_all → 触发', () => {
  assert.equal(mentionedAll({ message_type: 'text', content: '{"text":"@_all 都看下"}' }), true)
})

t('text 开头就是 @_all、后面没空格也算（末尾边界）', () => {
  assert.equal(mentionedAll({ message_type: 'text', content: '{"text":"@_all"}' }), true)
})

t('正文里嵌着 @_allxx 这种字符串 → 不误判', () => {
  assert.equal(mentionedAll({ message_type: 'text', content: '{"text":"a@_allb 看下"}' }), false)
})

t('普通群消息（没有任何 @）→ 不触发', () => {
  assert.equal(mentionedAll({ message_type: 'text', content: '{"text":"我先吃饭去"}' }), false)
})

t('post 里只 @ 了具体的人 → 不触发', () => {
  const m = {
    message_type: 'post',
    content: JSON.stringify({
      content: [[{ tag: 'at', user_id: '@_user_1', user_name: 'Eric' }]],
    }),
  }
  assert.equal(mentionedAll(m), false)
})

t('content 不是合法 JSON → 返回 false，不抛（收到脏报文不能整个进程崩）', () => {
  assert.equal(mentionedAll({ message_type: 'text', content: 'not json' }), false)
})

t('图片等其它类型 → false', () => {
  assert.equal(mentionedAll({ message_type: 'image', content: '{"image_key":"img_v3_x"}' }), false)
})

console.log('stripMentions:')

t('@_all 占位符要抠掉（它不在 mentions 里，得单独处理）', () => {
  assert.equal(stripMentions('@_all @_user_1 都看下', [{ key: '@_user_1' }]), '都看下')
})

t('普通 @ 照常抠', () => {
  assert.equal(stripMentions('@_user_1 关机了？', [{ key: '@_user_1' }]), '关机了？')
})

t('没有 @ 的正文原样返回', () => {
  assert.equal(stripMentions('我先吃饭去', []), '我先吃饭去')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
