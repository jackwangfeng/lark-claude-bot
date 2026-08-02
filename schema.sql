-- 群聊消息存档。落 PG 而不是文件：天然去重、能按发言人/时间范围查、
-- 以后要上 RAG 直接加一列 vector，不用改结构（本机已有 pgvector 镜像）。

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id   text PRIMARY KEY,          -- Lark 的 message_id，天然幂等
  chat_id      text        NOT NULL,
  bot_slug     text        NOT NULL,      -- 哪个 bot 收到的
  sender_id    text        NOT NULL,      -- open_id（按应用隔离，仅在本 bot 内有意义）
  sender_name  text,
  msg_type     text        NOT NULL,
  content      text        NOT NULL,
  sent_at      timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 主查询模式：某个群按时间倒序取最近 N 条
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_time
  ON chat_messages (chat_id, sent_at DESC);

-- 关键词检索。simple 配置不做词干化，中文靠 ILIKE/trigram 兜底，
-- 真要中文分词得装 zhparser，先不引这个依赖。
CREATE INDEX IF NOT EXISTS idx_chat_messages_content_trgm
  ON chat_messages USING gin (content gin_trgm_ops);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
