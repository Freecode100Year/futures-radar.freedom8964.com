-- 已部署 v0.1 的升级脚本：wrangler d1 execute news-radar --remote --file=migrations/0002_market.sql
ALTER TABLE events ADD COLUMN model_severity REAL;          -- 模型原始严重性（未经市场校准）
ALTER TABLE events ADD COLUMN market TEXT;                   -- JSON：市场反应与校准结果
ALTER TABLE events ADD COLUMN market_final INTEGER NOT NULL DEFAULT 0; -- 72 小时窗口结束后不再重算
ALTER TABLE events ADD COLUMN market_calibrated_at TEXT;

CREATE TABLE IF NOT EXISTS prices (
  instrument TEXT NOT NULL,
  ts         INTEGER NOT NULL,   -- unix 秒，小时K线
  close      REAL NOT NULL,
  PRIMARY KEY (instrument, ts)
) WITHOUT ROWID;

-- 严重性变化日志：深度分析和市场校准都会写入 → 前端趋势线
CREATE TABLE IF NOT EXISTS severity_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ts       TEXT NOT NULL,
  severity REAL NOT NULL,
  source   TEXT NOT NULL          -- 'analysis' | 'market'
);
CREATE INDEX IF NOT EXISTS idx_sevlog_event ON severity_log(event_id, ts);

INSERT INTO severity_log (event_id, ts, severity, source)
  SELECT event_id, created_at, severity, 'analysis' FROM analyses WHERE severity IS NOT NULL;
