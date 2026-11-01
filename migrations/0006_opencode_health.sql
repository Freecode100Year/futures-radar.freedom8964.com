-- 每日 OpenCode Zen 健康检查与活动免费模型
CREATE TABLE IF NOT EXISTS opencode_model_state (
  provider    TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  checked_day TEXT,
  status      TEXT,
  last_error  TEXT,
  updated_at  TEXT
);
