-- v0.5 → v0.6（行情工具）：wrangler d1 execute news-radar --remote --file=migrations/0006_market_tools.sql
-- 连续合约日线（OHLCV），用于多周期涨跌、技术指标、季节性、价差、相关性
CREATE TABLE IF NOT EXISTS daily_bars (
  instrument TEXT NOT NULL,
  day        TEXT NOT NULL,     -- 交易日 YYYY-MM-DD
  open REAL, high REAL, low REAL,
  close      REAL NOT NULL,
  volume     REAL,
  PRIMARY KEY (instrument, day)
) WITHOUT ROWID;

-- CFTC 持仓报告：商品为管理基金，金融期货为杠杆基金
CREATE TABLE IF NOT EXISTS cot (
  instrument    TEXT NOT NULL,
  report_date   TEXT NOT NULL,
  open_interest REAL,
  long          REAL NOT NULL,
  short         REAL NOT NULL,
  PRIMARY KEY (instrument, report_date)
) WITHOUT ROWID;

-- 财经日历（手动添加的一次性事件，如 FOMC、WASDE、CPI；周期性事件由代码生成）
CREATE TABLE IF NOT EXISTS calendar_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,      -- ISO 时间（UTC）
  title      TEXT NOT NULL,
  instruments TEXT,              -- JSON 数组
  importance INTEGER NOT NULL DEFAULT 2,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_calendar_ts ON calendar_events(ts);

-- 总览页的跨品种数据（相关性矩阵、价差），每小时计算一次
CREATE TABLE IF NOT EXISTS overview_snapshot (
  id         INTEGER PRIMARY KEY,
  updated_at TEXT,
  payload    TEXT
);
