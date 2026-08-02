// 邮箱/手机号 → open_id。用法：node whois.mjs a@b.com 13800138000
// 需要权限 contact:user.id:readonly
import { client } from './lark.mts'

/** catch 里的 e 是 unknown；Lark SDK 把业务错误塞在 e.response.data */
function errOf(e: unknown): { code?: number; msg?: string } {
  const x = e as { response?: { data?: { code?: number; msg?: string } }; message?: string }
  return { code: x?.response?.data?.code, msg: x?.response?.data?.msg ?? x?.message ?? String(e) }
}


const keys = process.argv.slice(2)
if (!keys.length) {
  console.error('用法: node whois.mjs <邮箱或手机号> [更多...]')
  process.exit(1)
}

const emails = keys.filter((k) => k.includes('@'))
const mobiles = keys.filter((k) => !k.includes('@'))

// ⚠️ 必须查 union_id，不能查 open_id：
// open_id 按应用隔离，用「查询实例」查出来的 open_id 填进别的 bot 的白名单
// 永远匹配不上，而且没有任何报错，极难排查。union_id 在同租户内跨应用稳定。
const r: any = await client.contact.user.batchGetId({
  params: { user_id_type: 'union_id' },
  data: { ...(emails.length ? { emails } : {}), ...(mobiles.length ? { mobiles } : {}) },
})

let missing = 0
for (const u of (r?.data?.user_list ?? []) as any[]) {
  const key = u.email || u.mobile
  if (u.user_id) {
    console.log(`${u.user_id}\t${key}`) // user_id 字段装的是 union_id（由 user_id_type 决定）
  } else {
    console.error(`查不到: ${key}（不在通讯录，或不在应用的通讯录权限范围内）`)
    missing++
  }
}
process.exit(missing ? 2 : 0)
