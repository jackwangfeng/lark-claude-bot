# 在这个项目里干活

给在这个仓库工作的 Claude 看的。容器里的 `docker/skel/CLAUDE.md` 是给 **bot** 看的，别搞混。

## 先读这个：改完怎么算「做好了」

这套东西的所有 bug 都有人在用 —— 定时任务坏两天没人知道、文档链接点开是 403、
群里的卡片一直转圈。所以「做好了」的标准不是代码写完，是**用户那一端真的能用**。

下面每条都对应本项目实际踩过的坑，不是通用建议。

### 1. 改代码用 Edit 工具，别用脚本做文本替换

`python str.replace()` 匹配不上是**静默 no-op**。踩过：往 `plugins/doc.mts` 插
`grantAccess()`，锚点没匹配上，**只有调用点进去了、函数定义没有**，
用户在 Lark 里看到「创建失败：grantAccess is not defined」才发现。

批量改多个文件时确实得用脚本，那就**改完立刻 grep 确认**：

```bash
grep -c "grantAccess" plugins/doc.mts    # 定义 + 调用，应该 ≥2
```

### 2. `npx tsc --noEmit` 退出 0 ≠ 检查过你改的文件

`tsconfig.json` 的 `include` 曾经是 `["*.mts"]`，**只匹配根目录**，
`plugins/` 下的文件从来没被检查过 —— 调用不存在的函数照样「通过」。

现在 include 是 `["*.mts", "plugins/**/*.mts"]`。新增目录时记得加进去，
并且用一个故意的错误验证它真的会报。

### 3. 不许拼 ID / URL / 路径，一律从 API 查

踩过：文档链接按 `https://open.larksuite.com/docx/<id>` 拼 —— 那是开放平台域名。
真实地址在**租户专属随机域名**下（`esgcvr7shapz.sg.larksuite.com`），
只能查 `drive/v1/metas/batch_query` 拿。用户点了半天「无权限」，
其实压根点错了地方。

### 4. `code=0` / `exit 0` 不是验收，用户能用才是

踩过三次：
- 授权 API 返回 `code=0` → 说「授权成功」，但没点过那个链接
- `scope.list` 显示 `grant_status=1` → 说「权限已生效」，实际还要发版 + 等几分钟
- 命令退出码 0 → 说「类型检查通过」，实际它没检查那些文件

**判断权限是否真生效的唯一方法是实际调一次接口。**

### 5. 验证要走用户实际会走的那条路

踩过：验「建文档」时用自己写的脚本调 SDK，而 bot 走的是
`plugins/doc.mts` 的 handler —— 两条不同的代码路径。
自己那条通了就宣布完成，结果 bot 那条是坏的。

调真实入口：

```js
const t = mod.default(ctx).instance._registeredTools['create_doc']
await t.handler({ ... }, {})
```

**产出物一旦交给用户验收，就不要再手动修改它**。改过之后它就不能证明
「原样产出是好的」了 —— 这个错犯过，导致多花了两轮才定位。

### 6. 加护栏时枚举所有入口

踩过：`larkapi` 的 deny 只拦了 `path` 参数，agent 换 `sdk` 参数就绕过去了。
自己发现后才补的 `denyBySdkName`。

### 7. 对无序集合别用 filter 保顺序

踩过：`blocks.filter(b => firstLevel.includes(b.block_id))` —— `blocks` 是
所有块的集合，数组顺序不保证等于文档顺序。写「一二三」建出来是「三一二」，
而且**间歇性**发作（第一次比对时恰好一致，看着像没问题）。
有序信息在 `first_level_block_ids` 里，要 `firstLevel.map(id => byId.get(id))`。

## 改动前后必做

```bash
npx tsc --noEmit          # 确认它覆盖了你改的文件
node test-attach.mts      # 附件合并的分支
node test-broken.mts      # 定时任务失败识别
./restart-safe.sh         # 重启（会先等正在跑的轮次结束）
./doctor.sh <slug>        # 实例体检
```

**别在对话进行中直接 `systemctl restart`** —— 会掐断用户正在跑的那一轮，
agent 那边看到 `Stream closed` 并且**多半会误判成权限问题**去跟用户解释。

## 这套系统的特殊性质

理解这几条能避开一大类错误：

**一条消息 = 一个新 CLI 进程。** 所以会话级的东西（`CronCreate`、`ScheduleWakeup`、
`run_in_background` 的等待循环）都不成立。定时任务必须走 PG（`plugins/schedule.mts`）。

**插件跑在宿主机的桥接进程里，不在容器里。** 所以加功能优先做成
`plugins/*.mts` —— 不用改 Dockerfile、不用重建容器、宿主机模式和容器模式自动一致。
但**路径要翻译**：agent 说 `/workspace/x.png`，宿主机上是
`~/.lark-agent/containers/<slug>/workspace/x.png`。

**上下文每轮都要重付。** prompt cache 能跨进程存活，但前缀一变（改
`docker/skel/CLAUDE.md`、改系统提示、改工具列表）所有会话的缓存全作废。
所以别频繁改这几处，攒着一起改。

**bot 发的消息不会触发 bot。** 想测「用户说话」的场景，只能请用户真的发一条 ——
自己用 `sendText` 发过去是没用的，这个错犯过好几次。

## 出了问题先看这里

日志里这几个前缀最有用：

```
[收到] [完成] [失败]     一轮对话的起止和成本
[定时]                   任务触发/完成
[账号池] [额度]          账号切换、限流
[ws] 掉线 / 已重连       长连接（一天十几次是常态，几秒自愈，不用管）
[补拉] 追回 N 条         重连后追回的消息，N>0 才值得看
[会话] 自动重置          群聊上下文超限
```

agent 观察到的现象往往只有一半，**归因经常是错的** —— 它说「MCP 不可靠」
可能是有人手动删了任务；说「环境拒绝写文件」可能是有人 restart 了服务；
说「后台任务被停掉了」可能它其实跑完了。查它的结论前先想想宿主机这边发生了什么。
