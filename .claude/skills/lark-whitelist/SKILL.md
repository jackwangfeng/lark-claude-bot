---
name: lark-whitelist
description: 改某个 lark bot 实例的私聊白名单 —— 加人、删人、查现在有谁。当用户说"给 xxx-bot 加个白名单""让某人能私聊这个 bot""授权 on_xxx / ou_xxx""把谁踢出白名单""这个 bot 现在谁能用"时用。
---

# lark bot 私聊白名单

白名单只管**私聊**。群聊走的是群成员名单 —— 任何群成员 @ 一下 bot 就服务，
跟这个文件无关。有人说「加了白名单群里还是没反应」，问题不在这儿，去查 `[未@我]` 日志。

## 文件在哪、长什么样

每个 bot 一份，在自己的状态目录里：

```
~/.lark-agent/<slug>/users.json
```

slug 就是 systemd 实例名（`lark-claude@jeff2` → `jeff2`）。用户嘴里的 bot 名字不一定等于
slug（「jeff-bot2」指的是 `jeff2`），拿不准先 `ls ~/.lark-agent/` 对一下。

```json
{
  "on_29a4b67cb99cbd0810a8b9e56e9f9b35": { "slug": "jeff2" },
  "on_d2bb7309f015694786012fdb453492e8": {}
}
```

键是 `union_id`（`on_` 开头）或 `open_id`（`ou_` 开头），**两种都能用**，
优先 union_id —— 换 bot 不用重配（见 `index.mts:479`）。

值里的 `slug` 现在**只当显示名**，容器是 bot 维度的、不由用户决定
（`index.mts:42-43`）。不知道对方叫什么就写 `{}`，代码会退回 `u<id 后 8 位>`
（`index.mts:54`）。**别瞎猜名字** —— 显示成 `u453492e8` 只是难看，写错名字是误标身份。

## 加人

直接用 Edit / Write 改 JSON。**不要重启服务** —— 白名单按 mtime 热加载
（`index.mts:46-49`），下一条消息自动生效。这个项目里 `systemctl restart`
会掐断别人正在跑的那一轮，见 CLAUDE.md。

## 验证

JSON 写坏了不会报错，只会静默沿用上一份（`index.mts:60-63`），所以**必须验**。
按 `loadUsers()` 的原样逻辑跑一遍：

```bash
node -e '
const {readFileSync}=require("fs");
const SLUG="jeff2";
const raw=JSON.parse(readFileSync(process.env.HOME+"/.lark-agent/"+SLUG+"/users.json","utf8"));
const map=new Map(Object.entries(raw).map(([id,v])=>[id,(typeof v==="string"?v:v?.slug)||("u"+id.slice(-8))]));
console.log("已加载 "+map.size+" 人："+[...map.values()].join(", "));
for(const [id,s] of map) console.log("  "+id+" -> lark-"+s);
'
```

生效后实例日志里会出现同样的一行 `[用户表] 已加载 N 人：...`（只在下一条消息到达时打）。

**真正的验收是那个人自己私聊一条**。bot 发的消息不触发 bot，你没法代他试 ——
把这一点直说，别把「文件改对了」说成「已经能用了」。

## 不知道对方 ID 时

让对方**先私聊 bot 一条**，然后：

```bash
journalctl --user -u lark-claude@<slug> -S "-1h" --no-pager | grep '忽略'
```

会看到 `[忽略] 未授权私聊 {"union_id":"on_...","open_id":"ou_...",...}`，挑 union_id 填。
对方那边也会收到一次「你还不在白名单里」的自动提示（每人只提示一次）。

## 查不到姓名是正常的

用 `mcp__larkapi` 反查别的 bot 的 union_id 会返回 `{"user_list":[]}` ——
union_id 是按应用维度发的，A 应用的 union_id 在 B 应用里查不到。
试一次没结果就别再试，直接写 `{}`，问用户这人是谁。

顺带：**读 `~/.lark-agent/*/env` 会被策略拦**（触及密钥文件），
别想着从那儿翻 app 凭证去查通讯录。

## 删人

从 JSON 里删掉那一行即可，同样热加载。

一个已知代价（`index.mts:473-477`）：私聊补拉走的是「这个会话上次通过鉴权的 open_id」，
所以**移除后 ≤2h 的补拉窗口内仍可能服务他一次**。要立刻断干净就得重启那个实例 ——
而重启会掐断正在跑的轮次，先问用户要不要。
