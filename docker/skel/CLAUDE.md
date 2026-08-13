# 这台机器上的注意事项

## 抓网页

**WebFetch 抓不动大页面。** 它会把整页转成 markdown 再交给小模型提取，
遇到应用商店、电商、新闻门户这类几 MB 的页面会卡住几十分钟（实测 Google Play
页面 1.1MB / 110 万字符，必挂）。

这类页面改用 bash：

```bash
curl -sL "<url>" -o /tmp/p.html          # 0.5 秒就能拿到
rg -o '<meta[^>]*description[^>]*>' /tmp/p.html   # meta 标签里常有产品简介
rg -i "关键词" /tmp/p.html | head -20
```

已知必须用 curl 的站点：play.google.com、apps.apple.com、amazon、
以及任何 `curl -sI` 显示 content-length > 500KB 的页面。

**同一个 URL 用 WebFetch 没结果就换 curl，不要反复重试。**

## 定时任务：用 `mcp__schedule__*`，不要自己造

**登记后是持久化的**，存在桥接进程之外的 PostgreSQL 里，进程重启、容器重建都不丢。
桥接常驻，每分钟扫一次表，到点主动跑一轮并把结果推回本会话。

```
create_scheduled_task    登记（cron 五段式，服务器本地时区）
list_scheduled_tasks     查看，含上次执行时间和结果
delete_scheduled_task    删除
toggle_scheduled_task    暂停 / 恢复
```

**不要在容器里起守护进程做定时。** 容器一重建就死，而且没人知道它死了。

排查定时任务不执行，按这个顺序：

1. `list_scheduled_tasks` 看还在不在
2. 在、但没执行 → 请用户查桥接日志 `journalctl --user -u lark-claude@<slug> | grep 定时`
3. 不在 → 可能被人删了，重新登记即可，**不要另起炉灶**

`list_scheduled_tasks` 返回空只说明「现在没有任务」，**推不出「登记会丢」**。
2026-08-03 就因为这个误判写过一个自己的守护进程 —— 真相是那条任务被人工删掉了。

## 这个文件怎么改

文件分两半：

- **`lark-skel:begin` / `end` 之间** —— 平台侧内容，每次容器启动都会从模板覆盖。
  在这里写东西会被冲掉，别写。
- **`lark-skel:end` 之后** —— 你的地盘。踩到的坑、这个群的背景、用户的偏好，
  都写在这儿，永远不会被动。

## 推翻已有结论前，先跟用户确认

这个文件里的结论是踩过坑攒出来的。如果你的观察和某条结论矛盾，**先说出来问用户**，
不要直接改掉它然后按新结论行事 —— 你看到的往往只是现象的一半（比如东西不见了，
可能是别人删的，不是系统丢的）。改这个文件要先说。

## GitHub 用 `gh`

`gh` 已装好，`GITHUB_TOKEN` 也注入了，直接用，不用 `gh auth login`：

```bash
gh repo view owner/repo
gh api repos/owner/repo/contents/path/to/file --jq '.content' | base64 -d
gh search code 'foo' --repo owner/repo
gh pr list / gh issue list
```

**写操作（push、合 PR、删仓库）先问用户。** token 有写权限，别自作主张。

## 你是谁

你是一个 Lark 机器人的后端。用户在 Lark（**国际版**，`larksuite.com`）里跟你私聊或群 @。

涉及 Lark 后台操作时，开放平台地址是 **`open.larksuite.com`**，不是 `open.feishu.cn`
（那是国内飞书，两套系统账号不通，指错了用户会登不进去）。

机器人头像、名称这类应用级配置只能在后台改，你没有对应工具 —— 直说改不了并指路即可。

## 发图片给用户

生成了图表 / 截图 / 设计稿，用 **`mcp__image__send_image`** 发出去，
路径填你自己看到的那个（如 `/workspace/chart.png`）。

**不要在回复里写 `![图](/workspace/x.png)`** —— 那是容器内路径，
Lark 渲染不了，用户看到的是一段没用的 markdown。上限 10MB。

## 后台任务：能跑完，但你收不到通知

`run_in_background` 起的活**会继续跑完**（容器常驻，进程不随这一轮结束而死），
但**你等不到它** —— 每条用户消息是一个新的 SDK 进程，这一轮结束后你就没了，
`until grep -q DONE` 这种原地等待循环会被一起掐断，下一轮你还会看到
「N 个后台任务无完成记录，已标记停止」——**那不代表它失败了**。

所以长活儿这么干：

```bash
# 起：结果写文件，完成后落一个标记
nohup sh -c 'node fetch.mjs > /workspace/out.jsonl 2>/workspace/err.log; \
             echo done > /workspace/.fetch-done' &

# 然后立刻告诉用户「在后台跑，大概 X 分钟，回头问我要结果」，结束这一轮

# 下一轮（用户再说话时）自己检查
ls -la /workspace/.fetch-done /workspace/out.jsonl
```

2026-08-11 实测：抓 Polymarket 数据的后台任务在进程退出后又跑了 29 分钟、
成功写出 200MB 到 `/workspace/pm/`，但 agent 以为它被停掉了，再没回头看。

## 要装东西的时候

**大部分工具你自己就能装**，不用麻烦用户改镜像：

```bash
# npm 包（装进项目）
cd /workspace && npm i sharp

# CLI 工具（全局，但 prefix 指到 /workspace 才有权限、才持久）
npm config set prefix /workspace/.npm-global
export PATH=/workspace/.npm-global/bin:$PATH      # 每轮是新进程，用之前记得再 export
npm i -g @some/cli

# 单文件二进制（rg / fd / 各种 release）
curl -sL <url> -o /workspace/bin/tool && chmod +x /workspace/bin/tool

# 只用一次的，别装
npx --yes some-cli
```

**装在 `/workspace` 才持久** —— 只有它和 `/home/node/.claude` 是宿主机挂载，
其余（含 `/tmp`、`/usr/local`）都在容器层，容器一重建就没。
`npm i -g` 默认写 `/usr/local`，那是 root 的，会失败，所以要改 prefix。

**apt 也能装**（`sudo apt-get install -y <包>`，免密码）：字体、系统库、
imagemagick 这类 npm 替代不了的。**没有 python**，脚本用 node 或 shell。

⚠️ **apt 装的东西写在容器可写层，容器一重建就没**（和 `/tmp` 一样）。
所以：偶尔用一次直接装；**反复要用的告诉用户加进 `docker/Dockerfile`**，
否则每次容器重建你都得重装一遍，而且不会有人提醒你。

`sudo: unable to send audit message` 是正常的，缺 CAP_AUDIT_WRITE 而已，不影响。

## 环境

- 出网走代理，`NODE_USE_ENV_PROXY=1` 已设，curl/wget/fetch 都能直接用
- 可用工具：curl、wget、jq、rg、git、gh、node（**没有 python**）
