-- 记录每个定时步骤最近一次的结果和错误，供 /api/data-status 排查
CREATE TABLE IF NOT EXISTS cron_log (
  step TEXT PRIMARY KEY,
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
