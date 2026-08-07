#!/usr/bin/env python3
"""扫码一键创建 Lark 应用，并预置桥接需要的权限和事件。

用法:
    # 只创建，打印凭证
    .venv/bin/python register-app.py <名称> [描述]

    # 创建后直接建实例（凭证不上屏，直接写进 ~/.lark-agent/<slug>/env）
    .venv/bin/python register-app.py <名称> [描述] --slug alice --users alice@corp.com

跑起来会打印一个链接，用 Lark 手机客户端扫码 → 在确认页选应用类型 → 确认。

⚠️ 确认页必须选「智能体」。机器人类型建出来的应用私聊输入框不可用，
   权限配全了也没用 —— 这是实测结论。

权限和事件通过 addons 预置，省掉后台「勾权限 → 发版 → 再勾 → 再发版」的来回。
应用类型不能在这里指定，只能在确认页选。
"""
import argparse
import subprocess
import sys
from pathlib import Path

import lark_oapi as lark

p = argparse.ArgumentParser(add_help=True)
p.add_argument("name", nargs="?", default="claude-bot", help="应用名称")
p.add_argument("desc", nargs="?", default="Lark ↔ Claude 桥接", help="应用描述")
p.add_argument("--slug", help="给了就自动调 new-bot.sh 建实例，凭证不打印到屏幕")
p.add_argument("--users", default="", help="白名单，逗号分隔，可填 union_id / 邮箱 / 手机号")
p.add_argument(
    "--intl",
    action="store_true",
    help="直接用国际版(larksuite)发起。默认从飞书域名起，扫码后按 tenant_brand 自动切；"
    "目标租户在国际版时加上这个，少绕一跳。注意：应用建到哪个租户由你扫码时"
    "手机客户端的当前组织决定，跟这个参数无关 —— 扫之前先在左上角切对组织。",
)
args = p.parse_args()

NAME, DESC = args.name, args.desc

# 桥接实际用到的权限，和 doctor.mjs 里那份保持一致。
# contact:* 只有「查询实例」需要，新 bot 不给 —— 见 new-bot.sh 的 LOOKUP 机制。
SCOPES = [
    "im:message",                        # 发消息 / 更新卡片
    "im:message.p2p_msg:readonly",       # 接收私聊
    "im:message.group_at_msg:readonly",  # 接收群里 @
    # ⚠️ 这两个名字很像但用途不同，都要：
    #   :readonly 是「收到群里每条消息的推送」——群聊记忆的地基，没它只能看到 @ 的那句
    #   不带后缀的是「调 API 拉群历史」——服务重启期间漏的消息靠它补回来
    "im:message.group_msg:readonly",
    "im:message.group_msg",
    # 群聊存档要记「谁说的」。缺了就只能显示 ou_1630e 这种 ID，可读性极差
    "im:chat.members:read",
    "contact:user.base:readonly",
    "im:message.reactions:write_only",   # 审批的 👍/❌
    "im:resource",                       # 下载图片 / 文件
]
EVENTS = ["im.message.receive_v1"]


def on_qr_code(info):
    url = info.get("url") if isinstance(info, dict) else info

    # ⚠️ 两条链接的区别很重要：
    #
    # 长链接带 addons（一大串 base64），权限和事件是**通过 URL 参数**传给
    # 网页端预置的 —— 不是服务端按 device_code 关联的。所以砍掉参数就没有预置，
    # 得回后台手动勾 9 个权限再发版。
    #
    # 但实测长链接（1000+ 字符）在某些客户端 / 浏览器下会报「链接已失效」，
    # 这时用短链接照样能建应用，只是权限要手动配。
    #
    # 所以两条都打出来：优先长的，不行再用短的。
    from urllib.parse import urlparse, parse_qs

    u = urlparse(url)
    code = (parse_qs(u.query).get("user_code") or [""])[0]
    short = f"{u.scheme}://{u.netloc}{u.path}?user_code={code}"

    print("\n" + "=" * 60)
    print(f"配对码：{code}\n")
    print("① 首选（自动预置 9 个权限 + 事件订阅）：\n")
    print(f"  {url}\n")
    print("② 上面那条报「链接已失效」时用这条 —— 能建应用，但权限要自己在后台配：\n")
    print(f"  {short}\n")
    print("用 Lark 手机客户端扫，确认页选「智能体」。")
    print("扫之前先在手机左上角把组织切到目标租户 —— 建到哪个租户由它决定。")
    print("=" * 60 + "\n", flush=True)


def on_status_change(status, *_):
    print(f"[状态] {status}", flush=True)


def main():
    print(f"创建应用：{NAME}")
    print(f"预置权限：{len(SCOPES)} 个，事件：{', '.join(EVENTS)}\n", flush=True)

    result = lark.register_app(
        on_qr_code=on_qr_code,
        on_status_change=on_status_change,
        app_preset={"name": NAME, "desc": DESC},
        addons={
            "scopes": {"tenant": SCOPES},
            "events": {"items": {"tenant": EVENTS}},
        },
        create_only=True,  # 只建新的，不复用已有应用
        # 国际版直接起，省掉 domain_switched 那一跳
        **({"domain": "https://accounts.larksuite.com"} if args.intl else {}),
    )

    app_id = result["client_id"]
    secret = result["client_secret"]

    print("\n" + "=" * 60)
    print("✅ 应用创建成功")
    print(f"App ID : {app_id}")

    if not args.slug:
        # 没指定 slug 就只能打出来让人接手
        print(f"Secret : {secret}")
        print("=" * 60)
        print("\n接下来：\n")
        print(f"  ./new-bot.sh <slug> {app_id} '{secret}' <对方邮箱>")
        print("  ./doctor.sh <slug>\n")
        return

    # 指定了 slug：secret 直接交给 new-bot.sh，不上屏、不进 shell 历史
    print("Secret : （不显示，直接写入实例配置）")
    print("=" * 60)
    print(f"\n建实例 {args.slug} …\n", flush=True)

    here = Path(__file__).resolve().parent
    cmd = [str(here / "new-bot.sh"), args.slug, app_id, secret]
    if args.users:
        cmd.append(args.users)
    rc = subprocess.call(cmd, cwd=here)
    if rc != 0:
        print(f"\n❌ new-bot.sh 退出码 {rc}。凭证已创建但实例没建成，手动补：")
        print(f"   ./new-bot.sh {args.slug} {app_id} '<secret>' {args.users or '<白名单>'}")
        print("   （secret 在 Lark 后台「凭证与基础信息」页可以再查）")
        sys.exit(rc)

    print(f"\n体检：./doctor.sh {args.slug}\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(130)
