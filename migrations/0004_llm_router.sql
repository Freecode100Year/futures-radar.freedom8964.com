-- v0.3 → v0.4：wrangler d1 execute news-radar --remote --file=migrations/0004_llm_router.sql
ALTER TABLE api_usage ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;

-- 各模型提供商的冷却状态（限流、key 无效、服务故障时暂停一段时间）
CREATE TABLE IF NOT EXISTS provider_state (
  provider       TEXT PRIMARY KEY,
  cooldown_until TEXT,
  last_error     TEXT,
  updated_at     TEXT
);
