// looksBroken 的单测：node test-broken.mts
// 定时任务「跑完了但其实失败了」的识别 —— carol 的新闻简报静默坏了两天才被发现。
// 注意后两条防误判用例：正文里出现「额度」「OAuth」是正常的，不能当故障。
function looksBroken(text: string, note?: string): string {
  if (note === 'rate_limited') return '账号额度用完了，这一轮没能执行'
  const head = (text || '').trim().slice(0, 200)
  if (!head) return '没有任何输出'
  const patterns: Array<[RegExp, string]> = [
    [/Failed to authenticate|OAuth session expired/i, '凭证失效，容器里的 Claude 登录态需要修复'],
    [/^⛔ 额度用完了/, '账号额度用完了'],
    [/Invalid API key|authentication_error/i, '认证失败'],
    [/binary exists but failed to launch|native binary at .* exited/i, 'Claude CLI 启动失败'],
    [/^❌ /, '执行出错'],
  ]
  for (const [re, why] of patterns) if (re.test(head)) return why
  return ''
}

const cases: Array<[string, string | undefined, boolean, string]> = [
  ['Failed to authenticate: OAuth session expired and could not be refreshed', undefined, true, 'carol 那次的真实文本'],
  ['⛔ 额度用完了，18:00 恢复。', undefined, true, '额度耗尽'],
  ['正常内容', 'rate_limited', true, 'note 标了限流'],
  ['❌ Claude Code native binary at /x/claude exited', undefined, true, 'CLI 启动失败'],
  ['', undefined, true, '空输出'],
  ['   ', undefined, true, '只有空白'],
  ['# 📊 全球市场简报\n\n今日主线：非农意外转负…', undefined, false, '正常简报'],
  ['今天没有额度相关的新闻，认证机构也没发声明。', undefined, false, '正文里提到额度/认证 —— 不能误判'],
  ['分析显示 OAuth 授权流程存在缺陷', undefined, false, '正文里提 OAuth —— 不能误判'],
]
let pass = 0
for (const [text, note, shouldFail, desc] of cases) {
  const r = looksBroken(text, note)
  const ok = Boolean(r) === shouldFail
  if (ok) pass++
  console.log(`  ${ok ? '✅' : '❌'} ${desc.padEnd(28)} → ${r || '（正常）'}`)
}
console.log(`\n  ${pass}/${cases.length} 通过`)
process.exit(pass === cases.length ? 0 : 1)
