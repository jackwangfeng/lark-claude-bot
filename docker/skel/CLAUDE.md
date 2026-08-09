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

## 环境

- 出网走代理，`NODE_USE_ENV_PROXY=1` 已设，curl/wget/fetch 都能直接用
- 可用工具：curl、wget、jq、rg、git、gh、python3
