# 每个 Lark 用户一个容器，桥接通过 `docker exec -i` 把 stream-json 协议穿进来
FROM node:22-bookworm-slim

# 构建期要走代理才能出网（宿主机 127.0.0.1:8890）；用 --network host 构建
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}

# curl/wget 是给 agent 的「轻量抓取」退路：WebFetch 会把整页转 markdown 再送小模型提取，
# 遇到 Google Play 这种 1.1MB 的页面就会卡住。有了这两个，它可以自己抓下来局部处理。
# jq/unzip 是处理抓下来的内容时常用的。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep less procps \
      curl wget jq unzip gnupg \
    && rm -rf /var/lib/apt/lists/*

# gh：GitHub 官方 CLI。比 github MCP 直接 —— agent 本来就会用 git/gh，
# 不用为了读个文件去记一套 mcp__github__* 工具名，也省掉每轮的工具定义开销。
# GITHUB_TOKEN 由运行期注入，gh 自动认这个环境变量，不用额外登录。
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# lark-mcp 预装进镜像：容器里跑 npx 要现拉包，代理慢的时候每轮对话都要等
RUN npm install -g @anthropic-ai/claude-code @larksuiteoapi/lark-mcp@0.5.1 \
    && npm cache clean --force

# 让 agent 能自己装 apt 包（字体、系统库、imagemagick 这类 npm 替代不了的）。
#
# 说明白：`sudo apt-get` 实质就是容器内 root —— deb 的 postinst 以 root 执行。
# 这里接受这个代价，因为容器内 root ≠ 宿主机 root：没挂 docker socket，
# 凭证本来就在容器里，所以 root 并没有多暴露什么。
# 但要真能用还需要 ensure.sh 那边放开 no-new-privileges 并补回 dpkg 要的
# capability（见 LARK_ALLOW_APT），不开的话装到一半会失败。
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'node ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg' \
       > /etc/sudoers.d/node-apt \
    && chmod 440 /etc/sudoers.d/node-apt

# 非 root 运行。node 镜像自带 uid/gid 1000 的 node 用户，直接复用
RUN mkdir -p /workspace && chown -R node:node /workspace

# 运行期的代理由 docker run -e 注入（host.docker.internal），不写死在镜像里
ENV HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy=

USER node
WORKDIR /workspace

# 容器要常驻，等着被 docker exec 进来；真正的活是 exec 起的 claude 干的
CMD ["sleep", "infinity"]
