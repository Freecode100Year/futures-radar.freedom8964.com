-- v0.2 → v0.3：wrangler d1 execute news-radar --remote --file=migrations/0003_cost.sql
ALTER TABLE events ADD COLUMN analyzed_count INTEGER NOT NULL DEFAULT 0; -- 上次深度分析时的报道数（重新分析门槛）
UPDATE events SET analyzed_count = article_count WHERE status = 'analyzed';

-- Claude 调用记账：每天 × 模型 × 用途一行
CREATE TABLE IF NOT EXISTS api_usage (
  day                TEXT NOT NULL,
  model              TEXT NOT NULL,
  purpose            TEXT NOT NULL,   -- triage | analysis
  calls              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, purpose)
);
