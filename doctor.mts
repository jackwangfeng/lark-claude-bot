// 体检：检查一个 bot 实例的 Lark 侧配置齐不齐，缺什么直接报出标识符。
// 用法：node doctor.mts            （用当前环境变量里的凭证）
//       ./doctor.sh mybot          （加载该实例的 env 再跑）
import { client, getBotInfo } from './lark.mts'

/** catch 里的 e 是 unknown；Lark SDK 把业务错误塞在 e.response.data */
function errOf(e: unknown): { code?: number; msg?: string } {
  const x = e as { response?: { data?: { code?: number; msg?: string } }; message?: string }
  return { code: x?.response?.data?.code, msg: x?.response?.data?.msg ?? x?.message ?? String(e) }
}


// 桥接实际会用到的能力。required=缺了功能就废，optional=缺了只影响单个特性。
//
// ⚠️ 用「任一满足」而不是单个字符串精确匹配 —— 智能体类型授予的是细分权限
// （im:message:send_as_bot / im:message:update …），没有笼统的 im:message。
// 早先按 im:message 精确匹配，把明明能正常发消息的智能体误报成「缺必需权限」。
const NEEDED: Array<{ any: string[]; required: boolean; why: string }> = [
  {
    any: ['im:message', 'im:message:send_as_bot'],
    required: true,
    why: '以机器人身份发消息',
  },
  {
    any: ['im:message', 'im:message:update'],
    required: true,
    why: '更新卡片（流式回复要它）',
  },
  {
    any: ['im:message.p2p_msg:readonly', 'im:message:readonly'],
    required: true,
    why: '接收私聊消息',
  },
  {
    any: ['im:message.group_at_msg:readonly', 'im:message:readonly'],
    required: true,
    why: '接收群里 @ 机器人的消息',
  },
  {
    any: ['im:message.group_msg:readonly', 'im:message:readonly'],
    required: false,
    why: '收到群里每条消息的推送 —— 群聊长期记忆的地基，缺了只能看到 @ 你的那句',
  },
  { any: ['im:message.group_msg'], required: false, why: '拉群历史，补服务重启期间漏掉的消息' },
  { any: ['im:chat.members:read'], required: false, why: '群聊存档里显示发言人名字，而不是 ou_xxxx' },
  { any: ['contact:user.base:readonly'], required: false, why: '同上，open_id → 姓名' },
  { any: ['im:message.reactions:write_only'], required: false, why: '审批时给消息加 👍/❌' },
  { any: ['im:resource'], required: false, why: '下载消息里的图片/文件' },
]

// 通讯录查询只需要「一个」实例有权限，new-bot.sh 会借用它（默认 admin，可用
// LARK_LOOKUP_SLUG 改）。所以不对每个 bot 都提示缺这两项。
const LOOKUP_ONLY = [{ scope: 'contact:user.id:readonly', why: '邮箱/手机号 → union_id' }]

let bad = 0

// 1) 凭证是否有效 + 机器人能力是否开启
let bot
try {
  bot = await getBotInfo()
  if (!bot?.openId) throw new Error('返回里没有 open_id')
  console.log(`✅ 凭证有效，机器人「${bot.name}」 open_id=${bot.openId}`)
} catch (e) {
  const d = errOf(e)
  console.log(`❌ 凭证无效或未开启机器人能力: ${errOf(e).msg}`)
  console.log('   → 检查 App ID/Secret，以及后台是否开启了「机器人」能力')
  process.exit(1)
}

// 2) 权限清单
let granted = new Set<string>()
try {
  const r: any = await client.application.scope.list()
  granted = new Set((r?.data?.scopes || r?.scopes || []).map((s: any) => s.scope_name))
  console.log(`✅ 已授予 ${granted.size} 个权限\n`)
} catch (e) {
  console.log('❌ 查不到权限列表:', errOf(e).msg)
  process.exit(1)
}

const missReq: typeof NEEDED = []
const missOpt: typeof NEEDED = []
for (const n of NEEDED) {
  if (n.any.some((x) => granted.has(x))) continue
  ;(n.required ? missReq : missOpt).push(n)
}

if (missReq.length) {
  bad = 1
  console.log('❌ 缺少必需权限（缺了机器人跑不起来）：')
  for (const n of missReq) console.log(`   ${n.any.join(' 或 ')}\n      用途：${n.why}`)
  console.log()
}
if (missOpt.length) {
  console.log('⚠️  缺少可选权限（只影响对应特性）：')
  for (const n of missOpt) console.log(`   ${n.any.join(' 或 ')}\n      用途：${n.why}`)
  console.log()
}
if (!missReq.length && !missOpt.length) console.log('✅ 权限齐全\n')

// 通讯录查询能力：有就报「本实例可当查询实例」，没有不算问题
const lookupOk = LOOKUP_ONLY.filter((n) => granted.has(n.scope))
if (lookupOk.length === LOOKUP_ONLY.length) {
  console.log('ℹ️  本实例具备通讯录查询权限，可作为 new-bot.sh 的查询实例')
  console.log('    （其他 bot 不需要这两个权限，会借用本实例）\n')
} else {
  console.log('ℹ️  本实例无通讯录查询权限 —— 正常，只需一个实例有即可')
  console.log(`    new-bot.sh 默认借用实例 "${process.env.LARK_LOOKUP_SLUG || 'admin'}"\n`)
}

if (missReq.length || missOpt.length) {
  console.log('补法：后台 →「权限管理」→ 按上面的标识符搜索勾选 → 创建版本 → 发布 → 管理员审核')
  console.log('     （只勾不发版不生效，这是最常踩的坑）')
}

// 3) 长连接。权限和凭证都对，但订阅方式没设成「长连接」的话，这里会一直失败，
//    表现为机器人完全收不到消息 —— 而上面的检查全是绿的，很容易误判。
const slug = process.env.LARK_SLUG || ''
if (slug) {
  const { execSync } = await import('node:child_process')
  try {
    const log = execSync(
      `journalctl --user -u lark-claude@${slug} --since "5 minutes ago" --no-pager -o cat 2>/dev/null || true`,
      { encoding: 'utf8' },
    )
    if (/ws client ready/.test(log)) {
      console.log('✅ 长连接已建立')
    } else if (/ws connect failed|connect failed/.test(log)) {
      bad = 1
      console.log('❌ 长连接建立失败 —— 机器人收不到任何消息')
      console.log('   → 后台「事件与回调」→ 订阅方式 → 改成「使用长连接接收事件/回调」')
      console.log('   → 并确认事件列表里有 im.message.receive_v1')
      console.log('   （订阅方式改完立即生效，不用发版）')
    } else {
      console.log('⚠️  最近 5 分钟日志里看不到长连接状态，重启实例后再查：')
      console.log(`   systemctl --user restart lark-claude@${slug}`)
    }
  } catch {
    /* 查不到日志就跳过这项 */
  }
}

// 4) 可用范围：白名单里的人在不在应用的可用范围内。
//    不在的话，他在 Lark 里搜不到这个机器人 / 输入框不可用 —— 而权限、长连接全是绿的，
//    极易误判成代码问题。扫码创建只会把创建者加进可用范围，其他人要手动加。
if (slug) {
  const { readFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.lark-agent', slug, 'users.json'), 'utf8'))
    const ids = Object.keys(raw)
    if (ids.length) {
      const r: any = await client.application.applicationVisibility.checkWhiteBlackList({
        path: { app_id: process.env.LARK_APP_ID! },
        data: { user_ids: ids },
        // 白名单推荐用 union_id；老配置里的 open_id 这里查不了，跳过即可
        params: { user_id_type: ids[0]!.startsWith('on_') ? 'union_id' : 'open_id' },
      })
      const out = r?.data?.user_visibility_list || r?.user_visibility_list || []
      const blocked = out.filter((u: any) => u.in_white_list === false)
      if (blocked.length) {
        bad = 1
        console.log('\n❌ 这些人不在应用的「可用范围」内，他们私聊不了这个机器人：')
        for (const u of blocked) console.log(`   ${u.user_id}  (${(raw as any)[u.user_id]?.slug || '?'})`)
        console.log('   → 后台 → 该应用 → 可用范围 → 添加成员')
      } else if (out.length) {
        console.log('\n✅ 白名单里的人都在可用范围内')
      }
    }
  } catch {
    /* 缺 self_manage 权限就查不了，跳过 */
  }
}

// 共享配置：漏了不会报错，只会静悄悄少功能 —— 定时任务登记失败、
// github MCP 每次调用 401。new-bot.sh 现在会自动继承，但老实例和手工建的可能缺。
{
  const shared = [
    { key: 'LARK_PG_DSN', hard: true, why: '定时任务 + 群聊长期记忆；缺了 agent 登记定时任务会失败' },
    { key: 'GITHUB_TOKEN', hard: false, why: '容器内 gh 的认证；缺了 agent 用不了 GitHub' },
  ]
  const missing = shared.filter((s) => !process.env[s.key])
  if (missing.length) {
    console.log('')
    for (const m of missing) {
      if (m.hard) bad = 1
      console.log(`${m.hard ? '❌' : 'ℹ️ '} 缺 ${m.key} —— ${m.why}`)
    }
    console.log(`   → 加进 ~/.lark-agent/${process.env.LARK_SLUG || '<slug>'}/env 后重启实例`)
    console.log('     （同机器其他实例的 env 里可以直接抄）')
  } else {
    console.log('\n✅ 共享配置齐全（PG / GitHub token）')
  }
}

process.exit(bad)
