-- 小时线保存 OHLC（用于小时K线），以及未来一小时风险展望
ALTER TABLE prices ADD COLUMN open REAL;
ALTER TABLE prices ADD COLUMN high REAL;
ALTER TABLE prices ADD COLUMN low REAL;

-- 未来一小时风险展望：统计区间（每整点生成）+ 事后核对
CREATE TABLE IF NOT EXISTS hourly_outlook (
  instrument   TEXT NOT NULL,
  window_start INTEGER NOT NULL,  -- 展望窗口 [window_start, window_start+3600)，unix 秒
  made_at      INTEGER NOT NULL,
  contract     TEXT,
  base_price   REAL NOT NULL,
  base_ts      INTEGER NOT NULL,  -- 基准价对应的时间（数据有延迟，通常早于 made_at）
  horizon_h    INTEGER NOT NULL,
  sigma_pct    REAL NOT NULL,
  lo68 REAL, hi68 REAL, lo95 REAL, hi95 REAL,
  events       TEXT,              -- JSON：窗口内的数据发布
  regime       REAL,
  actual       REAL,
  actual_ts    INTEGER,
  hit68        INTEGER,
  hit95        INTEGER,
  evaluated_at INTEGER,
  PRIMARY KEY (instrument, window_start)
);
CREATE INDEX IF NOT EXISTS idx_outlook_pending ON hourly_outlook (evaluated_at, window_start);

-- 每小时一次的 AI 情景解读（12 个品种合并为一次请求）
CREATE TABLE IF NOT EXISTS hourly_commentary (
  window_start INTEGER PRIMARY KEY,
  payload      TEXT NOT NULL,
  model        TEXT,
  created_at   INTEGER NOT NULL
);
