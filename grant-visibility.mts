// 把人加进某个应用的「可用范围」。
//
// 凭证和目标应用是分开的：admin:app.visibility 是租户级权限，所以可以用
// 「管理实例」的凭证去改别的应用。
//
// 用法：
//   set -a; . ~/.lark-agent/admin/env; set +a          # 用管理实例的凭证
//   LARK_TARGET_APP_ID=cli_xxx node grant-visibility.mjs on_xxx [on_yyy ...]
//
// 不设 LARK_TARGET_APP_ID 就改凭证自己那个应用。
import { client } from './lark.mts'

/** catch 里的 e 是 unknown；Lark SDK 把业务错误塞在 e.response.data */
function errOf(e: unknown): { code?: number; msg?: string } {
  const x = e as { response?: { data?: { code?: number; msg?: string } }; message?: string }
  return { code: x?.response?.data?.code, msg: x?.response?.data?.msg ?? x?.message ?? String(e) }
}


const ids = process.argv.slice(2)
if (!ids.length) {
  console.error('用法: LARK_TARGET_APP_ID=cli_xxx node grant-visibility.mjs <union_id> [更多...]')
  process.exit(1)
}

const TARGET = process.env.LARK_TARGET_APP_ID || process.env.LARK_APP_ID
console.log(`目标应用: ${TARGET}`)

// 先校验格式再发请求。调用方常从别的命令的 stdout 里抓 ID，抓错了的话
// 服务端只会回一句含糊的 "open_id cross app"，很难反推是上游污染。
const bad = ids.filter((id) => !/^(on_|ou_)[A-Za-z0-9]+$/.test(id))
if (bad.length) {
  console.log(`❌ 这些不是合法的 union_id / open_id：${JSON.stringify(bad)}`)
  process.exit(1)
}

const idType = ids[0]!.startsWith('on_') ? 'union_id' : 'open_id'

try {
  await client.application.applicationVisibility.patch({
    path: { app_id: TARGET! },
    params: { user_id_type: idType },
    data: { add_visible_list: { user_ids: ids } },
  })
  console.log('✅ 已提交，复查中…')
} catch (e) {
  const d = errOf(e)
  console.log('❌ 改不了 code=' + d?.code, (errOf(e).msg ?? '').slice(0, 160))
  process.exit(1)
}

// 复查：以服务端为准，不信「提交成功」这四个字
const r: any = await client.application.applicationVisibility.checkWhiteBlackList({
  path: { app_id: TARGET! },
  data: { user_ids: ids },
  params: { user_id_type: idType },
})
for (const u of (r?.data?.user_visibility_list ?? []) as any[]) {
  console.log(`${u.in_white_list ? '✅' : '❌'} ${u.user_id}  白名单=${u.in_white_list}`)
}
