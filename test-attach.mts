// planAttach 的单测：node test-attach.mts
// 附件合并的分支容易想漏，尤其「先发图再打字」那条 —— 那句话本身不带附件。
import assert from 'node:assert'
import { planAttach } from './attach.mts'

const f = (n: string) => ({ path: `/workspace/uploads/${n}`, kind: '图片' })
let pass = 0

function t(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    pass++
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}

console.log('planAttach:')

t('纯文字、无缓冲 → 不干预（不能给普通消息加延迟）', () => {
  assert.deepEqual(planAttach({ incoming: [], hasText: true, isCmd: false }), { action: 'pass' })
})

t('第一张图 → 等', () => {
  const r = planAttach({ incoming: [f('a')], hasText: false, isCmd: false })
  assert.equal(r.action, 'wait')
  assert.deepEqual((r as any).files, [f('a')])
})

t('第二、三张图 → 累积着等', () => {
  const r = planAttach({ pending: [f('a')], incoming: [f('b')], hasText: false, isCmd: false })
  assert.equal(r.action, 'wait')
  assert.deepEqual((r as any).files, [f('a'), f('b')])
})

t('图 + 同一条里带文字 → 立刻跑', () => {
  const r = planAttach({ incoming: [f('a')], hasText: true, isCmd: false })
  assert.equal(r.action, 'go')
  assert.deepEqual((r as any).files, [f('a')])
})

t('先发 3 张图、再打一句话 → 一起跑（这条最容易漏）', () => {
  const r = planAttach({
    pending: [f('a'), f('b'), f('c')],
    incoming: [], // 这句话不带附件
    hasText: true,
    isCmd: false,
  })
  assert.equal(r.action, 'go')
  assert.deepEqual((r as any).files, [f('a'), f('b'), f('c')])
})

t('攒着图时来了斜杠命令 → 放行命令，缓冲区不动', () => {
  const r = planAttach({ pending: [f('a')], incoming: [], hasText: true, isCmd: true })
  assert.deepEqual(r, { action: 'pass' })
})

t('顺序：先攒的在前', () => {
  const r = planAttach({ pending: [f('1')], incoming: [f('2')], hasText: true, isCmd: false })
  assert.deepEqual((r as any).files.map((x: any) => x.path.at(-1)), ['1', '2'])
})

console.log(`\n${pass}/7 通过`)
process.exit(pass === 7 ? 0 : 1)
