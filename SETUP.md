# 新建一个 Lark 机器人

> ## ⚠️ 两种运行模式，别搞混
>
> | 实例 | 模式 | 用途 | 风险 |
> |---|---|---|---|
> | `myself` | **宿主机** | 直接控制这台机器 | 能私聊它的人 ≈ 本机 root（免密 sudo + 免审批） |
> | 其他（给同事的） | **容器** | 给同事用 | 关在容器里，碰不到宿主机 |
>
> 宿主机模式靠 drop-in 打开：
> `~/.config/systemd/user/lark-claude@<slug>.service.d/host-mode.conf`
> 里写 `LARK_CONTAINER_MODE=false`。模板 unit 默认是容器模式。
>
> **宿主机模式的实例必须满足两条**：
> 1. `users.json` 只有你自己
> 2. **绝不拉进任何群** —— 群聊规则是「谁 @ 都服务」，不看 `users.json`，
>    进群等于把宿主机 root 交给群里所有人
>
> 给同事新建的 bot 一律走容器模式（默认），不要加 drop-in。

> ⚠️ **应用类型必须选「智能体」,不能选「机器人」。**
> 实测:机器人类型建出来的应用,私聊连输入框都不可用,权限配全了也没用;
> 智能体类型一次就通。这是本文档最重要的一条。

推荐走**扫码创建**,权限和事件一次配好,不用进后台勾选、也不用发版。

---

## 一、扫码创建应用(推荐)

```bash
cd ~/work/lark
.venv/bin/python register-app.py my-bot "mybot 的 Claude 助手"
```

会打印一个链接 → 用 Lark 手机端扫 → **确认页选「智能体」** → 直接吐出 App ID / App Secret。

脚本已把桥接需要的权限和事件预置在 `addons` 里(和 `doctor.mjs` 的清单一致):

```
im:message                        发消息 / 更新卡片
im:message.p2p_msg:readonly       接收私聊
im:message.group_at_msg:readonly  接收群里 @
im:message.group_msg:readonly     读群历史（@ 不带内容时接上一句）
im:message.reactions:write_only   审批的 👍/❌
im:resource                       下载图片 / 文件

事件: im.message.receive_v1
```

**实测对比**:扫码建的智能体拿到 37 个权限、`doctor` 直接报齐全;后台手工建的机器人只有 7 个,勾了发版还是缺。

> 链接有效期只有几分钟,过期就重跑一次。
> `contact:*` 故意没预置 —— 只有「查询实例」需要,见第三节。

---

## 二、建实例

```bash
./new-bot.sh mybot <app_id> '<app_secret>' <对方邮箱>
./doctor.sh mybot
```

`new-bot.sh` 自动完成:邮箱转 union_id、写凭证(600)、写白名单、注册 systemd、启动、验活。

`doctor.sh` 检三件事,全绿才算通:

```
✅ 凭证有效，机器人「my-bot」 open_id=ou_...
✅ 已授予 37 个权限 / ✅ 权限齐全
✅ 长连接已建立
```

> **长连接那一项最容易被忽略** —— 权限和凭证全对但订阅方式不是「长连接」时,
> 机器人收不到任何消息,而且没有任何报错。`doctor` 会明确报出来。

---

## 三、白名单:一定要用 union_id

**`open_id` 是按应用隔离的** —— 同一个人在不同 bot 下是不同的 ID:

```
同一个人在 bot-A 下   ou_aaaaaaaa...
同一个人在 bot-B 下   ou_bbbbbbbb...   ← 完全不同
这个人的 union_id     on_cccccccc...   ← 两边一致
```

拿 A 应用查到的 open_id 填进 B 应用的白名单,**永远匹配不上,而且毫无报错**,极难排查。
所以白名单一律用 `union_id`(`on_` 开头)。

`~/.lark-agent/<slug>/users.json`,改完**即刻生效,不用重启**:

```json
{
  "on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": { "slug": "alice", "note": "张三" }
}
```

匹配时 open_id / union_id / user_id 三者任一命中即可,所以老的 open_id 白名单仍然有效。

### 怎么拿 union_id

**A. 用邮箱/手机号查**(需要一个有 `contact:user.id:readonly` 的「查询实例」，见 LARK_LOOKUP_SLUG):

```bash
set -a; . ~/.lark-agent/admin/env; set +a
node whois.mjs alice@corp.com
# on_29a4b67c...	alice@corp.com
```

`new-bot.sh` 第四个参数填邮箱时会自动借用这个实例来查(可用 `LARK_LOOKUP_SLUG` 换)。
**其他 bot 不需要这个权限。**

**B. 从日志捞**(零权限):

```bash
journalctl --user -u lark-claude@mybot -f | grep 未授权
# [忽略] 未授权私聊 {"open_id":"ou_...","union_id":"on_...","user_id":"..."}
```

让对方私聊发一句,三个 ID 都会打出来,挑 `union_id` 填。

---

## 四、验证

让对方私聊机器人发一句:

```bash
journalctl --user -u lark-claude@mybot -f
```

| 现象 | 含义 |
|---|---|
| `[收到]` → `[完成]` | 全通了 |
| `[忽略] 未授权私聊 {...}` | 链路通,白名单没配 —— 把 `union_id` 填进 `users.json` |
| **完全没记录** | 消息没推过来 —— 应用类型不对 / 未发布 / 可用范围没含此人 / 订阅方式不是长连接 |
| `❌ ... 403` | 代理问题,不是 Lark 侧(见 unit 里的 `HTTPS_PROXY`) |

第三行是最麻烦的一类,`doctor.sh` 只能查出「长连接」这一项,其余要去后台对照。

---

## 五、日常运维

```bash
systemctl --user list-units 'lark-claude@*'      # 所有实例
systemctl --user restart lark-claude@mybot       # 改代码后重启（所有实例共用代码）
journalctl --user -u lark-claude@mybot -f        # 跟日志
./doctor.sh mybot                                # 体检
```

每个实例的数据:

```
~/.lark-agent/<slug>/
  env            凭证（600）
  users.json     私聊白名单（热加载）
  sessions.json  会话表
~/.lark-agent/containers/<slug>/{workspace,claude}
```

**授权模型**:私聊看 `users.json`;**群聊是「群里谁 @ 都服务」**,不看白名单 —— 所以别把个人 bot 拉进不该进的群。

---

## 附:手工后台创建(不推荐)

扫码流程走不通时的退路。**类型仍然必须选智能体。**

1. <https://open.larksuite.com/app> → 创建应用
2. 添加「机器人」能力
3. 事件与回调 → 订阅方式选**长连接** → 添加事件 `im.message.receive_v1`
4. 权限管理 → 按第一节那份标识符逐个勾(**按标识符搜,别按中文名**)
5. 数据权限 → 通讯录权限范围(只有查询实例需要)
6. 可用范围设为指定成员 → 创建版本 → 发布 → 管理员审核

> 只勾权限不发版不生效,这是手工路径最常踩的坑。
> `contact:user.id:readonly`(邮箱反查 ID)和 `contact:user.base:readonly`(ID 查信息)
> 名字像但用途相反,别勾错。
