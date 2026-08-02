# 加功能

不用改核心代码。两条路，按需求选：

## A. 社区现成的 MCP server → 改 `../mcp.json`

天气、GitHub、Notion、Playwright、数据库…… 大多有人做好了。加三行即可：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

- `env` 里的 `${VAR}` 用桥接进程的同名环境变量替换 —— **密钥写在 `~/.lark-agent/<slug>/env`，别写进 json**
- `scope`：`all`（默认）/ `group` 只群聊 / `dm` 只私聊
- `deny`：禁止的工具名数组（不带 `mcp__<server>__` 前缀）
- `disabled: true` 临时关掉

> ⚠️ **容器模式下这些 server 由容器内的 CLI 启动**，`command` 必须在镜像里存在。
> 用 `npx` 每轮都要拉包（走代理很慢），常用的建议预装进 `docker/Dockerfile`。

改完 `systemctl --user restart lark-claude@<slug>` 即可。

## B. 需要访问本地上下文 → 加 `plugins/<name>.mts`

要用到 PG、chatId、Lark 凭证的自研工具走这条。

```typescript
// plugins/weather.mts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { PluginContext } from '../plugins.mts'

export const scope = 'all'          // 可选：all | group | dm

export default (ctx: PluginContext) =>
  createSdkMcpServer({
    name: 'weather',
    version: '1.0.0',
    tools: [
      tool(
        'get_weather',
        '查某地天气。说明写清楚「什么时候该用」，模型才会主动选它。',
        { city: z.string().describe('城市名') },
        async ({ city }) => ({
          content: [{ type: 'text' as const, text: `${city}：晴，25°C` }],
        }),
      ),
    ],
  })
```

- 文件名即 server 名 → 工具全名是 `mcp__weather__get_weather`
- `_` 开头的文件会被跳过（放共享代码用）
- 返回 `null` 表示这次不启用（比如缺配置）
- **单个插件抛异常只跳过它**，不影响其他插件和主流程

`ctx` 里有 `chatId` / `slug` / `isGroup`。

## 会踩的坑

**工具描述要写「什么时候用」，不只是「做什么」。** 模型手里有几十个工具，
描述模糊它就不会选 —— 定时器那次它宁可去用 Claude 云端的 routine，
最后是在系统提示里明确指路才好使。

**`allowedTools` 是「额外允许」不是「唯一允许」**，挡不住任何东西。
要禁必须用 `disallowedTools`（`mcp.json` 里的 `deny` 就是干这个的）。

**改完必须重启** —— 插件在 `run()` 时加载，但 Node 的 import 有缓存，
同一进程内改了文件不会重新读。
