// 停用/启用一个应用。删除没有 API，只能停用（可逆）。
// 用法：
//   set -a; . ~/.lark-agent/admin/env; set +a
//   node disable-app.mjs <app_id> [on]      # 不带 on = 停用，带 on = 恢复
import { client } from './lark.mts'

/** catch 里的 e 是 unknown；Lark SDK 把业务错误塞在 e.response.data */
function errOf(e: unknown): { code?: number; msg?: string } {
  const x = e as { response?: { data?: { code?: number; msg?: string } }; message?: string }
  return { code: x?.response?.data?.code, msg: x?.response?.data?.msg ?? x?.message ?? String(e) }
}


const target = process.argv[2]
const enable = process.argv[3] === 'on'
if (!target) {
  console.error('用法: node disable-app.mjs <app_id> [on]')
  process.exit(1)
}

// 先确认要动的是哪个应用 —— 停错应用是很难解释的事故
try {
  const g: any = await client.application.application.get({
    path: { app_id: target },
    params: { lang: 'zh_cn' },
  })
  const a = g?.data?.app || g?.app || g?.data
  console.log(`目标: ${a?.app_name || '(取不到名字)'}  (${target})`)
} catch (e) {
  console.log(`⚠️  取不到应用信息(${errOf(e).code}), 仍按 app_id 操作: ${target}`)
}

try {
  await client.application.applicationManagement.update({
    path: { app_id: target },
    data: { enable },
  })
  console.log(enable ? '✅ 已启用' : '✅ 已停用')
} catch (e) {
  const d = errOf(e)
  console.log('❌ 操作失败 code=' + d?.code, (errOf(e).msg ?? '').slice(0, 160))
  process.exit(1)
}
