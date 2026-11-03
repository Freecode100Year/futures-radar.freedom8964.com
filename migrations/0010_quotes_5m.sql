-- 每 5 分钟行情
-- 每 5 分钟更新：5 分钟K线（保留 7 天）与各品种最新报价
CREATE TABLE IF NOT EXISTS prices_5m (
  instrument TEXT NOT NULL,
  contract   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  open REAL, high REAL, low REAL,
  close      REAL NOT NULL,
  volume     INTEGER,
  PRIMARY KEY (instrument, contract, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS quotes (
  instrument  TEXT PRIMARY KEY,
  contract    TEXT,
  price       REAL NOT NULL,
  prev_close  REAL,              -- 前一交易日结算/收盘，用于当日涨跌
  market_time INTEGER,           -- 行情时间（交易所延迟后的时间）
  updated_at  INTEGER NOT NULL   -- 本站抓取时间
);
