// 每 5 分钟的行情：全部 12 个品种的最新价（含前一交易日收盘，用来算当日涨跌）和 5 分钟K线。
// 数据源仍是 Yahoo 的交易所延迟行情（CME/CBOT 约 10 分钟，COMEX/NYMEX 约 30 分钟）：
// 更新频率提高到 5 分钟，只是让页面不再额外落后，数据本身的延迟不变。
import { INSTRUMENTS } from './instruments.js';
import { activeContract } from './contracts.js';

const UA = 'Mozilla/5.0 (compatible; FuturesRadar/1.0)';
const KEEP_DAYS = 7;

/** 解析 Yahoo 图表接口：5 分钟K线 + 元数据中的最新价、前收盘 */
export function parseYahooIntraday(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'Yahoo 返回为空');
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (!Number.isFinite(q.close?.[i])) continue;
    bars.push({ ts: ts[i], open: q.open?.[i] ?? q.close[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i], close: q.close[i], volume: Number(q.volume?.[i]) || 0 });
  }
  const m = r.meta || {};
  const last = bars.at(-1);
  return {
    bars,
    price: Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : last?.close ?? null,
    market_time: Number.isFinite(m.regularMarketTime) ? m.regularMarketTime : last?.ts ?? null,
    prev_close: Number.isFinite(m.previousClose) ? m.previousClose : Number.isFinite(m.chartPreviousClose) ? m.chartPreviousClose : null,
  };
}

export async function fetchYahooIntraday(symbol, range = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=${range}`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return parseYahooIntraday(await res.json());
}

/**
 * 抓取全部品种的 5 分钟行情。每次只重写最近 30 分钟的K线（未收盘的那根会被后续完整K线覆盖）；
 * 某个品种库里还没有 5 分钟数据时拉 5 天。
 */
export async function updateQuotes(env, { nowSec = Math.floor(Date.now() / 1000), fetcher = fetchYahooIntraday } = {}) {
  const report = [];
  await Promise.all(INSTRUMENTS.map(async (inst) => {
    try {
      const active = await activeContract(env, inst.key);
      const last = (await env.DB.prepare('SELECT MAX(ts) AS t FROM prices_5m WHERE instrument = ? AND contract = ?').bind(inst.key, active.contract).first())?.t;
      const d = await fetcher(active.symbol, last && last > nowSec - 2 * 86400 ? '1d' : '5d');
      const fresh = last ? d.bars.filter((b) => b.ts >= last - 1800) : d.bars;
      const stmts = fresh.map((b) => env.DB.prepare('INSERT OR REPLACE INTO prices_5m (instrument, contract, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(inst.key, active.contract, b.ts, b.open, b.high, b.low, b.close, b.volume));
      if (d.price !== null) {
        stmts.push(env.DB.prepare(
          `INSERT INTO quotes (instrument, contract, price, prev_close, market_time, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(instrument) DO UPDATE SET contract = excluded.contract, price = excluded.price, prev_close = COALESCE(excluded.prev_close, quotes.prev_close),
             market_time = excluded.market_time, updated_at = excluded.updated_at`,
        ).bind(inst.key, active.contract, d.price, d.prev_close, d.market_time, nowSec));
      }
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      report.push({ instrument: inst.key, contract: active.contract, price: d.price, written: fresh.length });
    } catch (e) {
      report.push({ instrument: inst.key, error: e.message });
    }
  }));
  return report;
}

export async function purgeQuotes(env, nowSec = Math.floor(Date.now() / 1000)) {
  await env.DB.prepare('DELETE FROM prices_5m WHERE ts < ?').bind(nowSec - KEEP_DAYS * 86400).run();
}

/** 全部品种的最新报价：{ key: { price, prev_close, chg_pct, market_time, updated_at, contract } } */
export async function latestQuotes(env) {
  try {
    const { results } = await env.DB.prepare('SELECT * FROM quotes').all();
    return Object.fromEntries(results.map((r) => [r.instrument, quoteOut(r)]));
  } catch {
    return {}; // 迁移 0010 未执行
  }
}

export function quoteOut(r) {
  return {
    contract: r.contract,
    price: r.price,
    prev_close: r.prev_close,
    chg_pct: r.prev_close ? Math.round((r.price / r.prev_close - 1) * 10000) / 100 : null,
    market_time: r.market_time ? new Date(r.market_time * 1000).toISOString() : null,
    updated_at: new Date(r.updated_at * 1000).toISOString(),
  };
}

/** 某品种近 hours 小时的 5 分钟K线（最新合约） */
export async function intradayCandles(env, key, { nowSec = Math.floor(Date.now() / 1000), hours = 24 } = {}) {
  const c = await env.DB.prepare('SELECT contract FROM prices_5m WHERE instrument = ? ORDER BY ts DESC LIMIT 1').bind(key).first();
  if (!c) return { contract: null, candles: [] };
  const { results } = await env.DB.prepare('SELECT ts, open, high, low, close FROM prices_5m WHERE instrument = ? AND contract = ? AND ts >= ? ORDER BY ts')
    .bind(key, c.contract, nowSec - hours * 3600).all();
  let prev = null;
  const candles = results.map((r) => {
    const out = { t: r.ts, o: r.open, h: r.high, l: r.low, c: r.close, chg_pct: prev ? Math.round((r.close / prev - 1) * 100000) / 1000 : null };
    prev = r.close;
    return out;
  });
  // 最后一根在数据延迟（最长约 30 分钟）范围内，可能还没走完，标为未收盘
  const last = candles.at(-1);
  if (last && nowSec - last.t < 45 * 60) last.partial = true;
  return { contract: c.contract, candles };
}
