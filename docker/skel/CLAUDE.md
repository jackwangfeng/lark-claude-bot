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

## 环境

- 出网走代理，`NODE_USE_ENV_PROXY=1` 已设，curl/wget/fetch 都能直接用
- 可用工具：curl、wget、jq、rg、git、python3
