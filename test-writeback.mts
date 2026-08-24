// writeBack 的护栏单测：node test-writeback.mts
//
// 防的是数据毁坏，不是功能不通 —— 所以值得有测试。
// 2026-08-24 踩过：验备用号时刷新失败，Claude Code 把 token 抹空，
// writeBack 照原样写回，池里那份被永久覆盖，只能从备份捞。
import assert from 'node:assert'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = await mkdtemp(join(tmpdir(), 'acctest-'))
process.env.LARK_ACCOUNTS_DIR = DIR
// 网关模式下 writeBack 直接 return，会让所有断言失效 —— 显式关掉
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN

const { writeBack } = await import('./accounts.mts')

const good = (tag: string) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'a-' + tag, refreshToken: 'r-' + tag, expiresAt: Date.now() + 3600_000 },
  })

let pass = 0
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
    pass++
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const POOL = join(DIR, 'main.json')
const CONT = join(DIR, 'container-cred.json')

await t('正常刷新：写回', async () => {
  await writeFile(POOL, good('old'))
  await writeFile(CONT, good('new'))
  await writeBack('main', CONT)
  assert.match(await readFile(POOL, 'utf8'), /r-new/, '刷新后的凭证应该写进池里')
})

await t('刷新失败（token 被抹空）：不写回，池里原件保住', async () => {
  await writeFile(POOL, good('keep'))
  await writeFile(CONT, JSON.stringify({ claudeAiOauth: { scopes: ['user:inference'] } }))
  await writeBack('main', CONT)
  assert.match(await readFile(POOL, 'utf8'), /r-keep/, '空凭证不该覆盖池里的原件')
})

await t('只剩 accessToken 没有 refreshToken：也不写回', async () => {
  await writeFile(POOL, good('keep2'))
  await writeFile(CONT, JSON.stringify({ claudeAiOauth: { accessToken: 'a-x' } }))
  await writeBack('main', CONT)
  assert.match(await readFile(POOL, 'utf8'), /r-keep2/, '缺 refreshToken 等于下次切回来就废了')
})

await t('容器凭证是坏 JSON：不写回', async () => {
  await writeFile(POOL, good('keep3'))
  await writeFile(CONT, '{ 这不是 json')
  await writeBack('main', CONT)
  assert.match(await readFile(POOL, 'utf8'), /r-keep3/, '解析不了就别动池子')
})

await t('顶层不带 claudeAiOauth 包装：也认得', async () => {
  await writeFile(POOL, good('old2'))
  await writeFile(CONT, JSON.stringify({ accessToken: 'a-flat', refreshToken: 'r-flat' }))
  await writeBack('main', CONT)
  assert.match(await readFile(POOL, 'utf8'), /r-flat/, '两种外形都要支持')
})

await t('池里没这个号：不创建新文件', async () => {
  await writeFile(CONT, good('ghost'))
  await writeBack('不存在的号', CONT)
  await assert.rejects(readFile(join(DIR, '不存在的号.json'), 'utf8'))
})

await rm(DIR, { recursive: true, force: true })
console.log(`\n  ${pass}/6 通过`)
