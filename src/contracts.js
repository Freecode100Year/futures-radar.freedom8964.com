// 期货合约：月份代码、候选合约、主力合约识别、期限结构
import { INSTRUMENTS, byKey } from './instruments.js';

export const MONTH_CODES = 'FGHJKMNQUVXZ'; // 1–12 月
const DAY = 86400;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 从当前月份起，按品种的交割月周期列出接下来 n 个合约 */
export function candidateContracts(inst, nowSec, n = 8) {
  const d = new Date(nowSec * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth(); // 0-11
  const out = [];
  for (let i = 0; i < 30 && out.length < n; i++) {
    const code = MONTH_CODES[m];
    if (inst.months.includes(code)) {
      const contract = `${inst.root}${code}${String(y).slice(-2)}`;
      out.push({ contract, symbol: `${contract}.${inst.exchange}`, month: `${y}-${String(m + 1).padStart(2, '0')}` });
    }
    if (++m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

export const monthsBetween = (a, b) => {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};

/** Yahoo chart 响应 → [{ts, close, volume}] */
export function parseYahooBars(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'Yahoo 返回为空');
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (Number.isFinite(q.close?.[i])) out.push({ ts: ts[i], close: q.close[i], volume: Number(q.volume?.[i]) || 0 });
  }
  return out;
}

export async function fetchYahooBars(symbol, { interval = '60m', range = '5d' } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return parseYahooBars(await res.json());
}

/**
 * 解析期限结构：依次取候选合约最近一个月的日线，保留仍在交易（最近 7 天有成交）的合约，
 * 最多 6 个。主力合约 = 最近的 3 个有效合约中，近 3 日平均成交量最大的那个。
 */
export async function resolveCurve(inst, nowSec, { maxPoints = 6, fetcher = fetchYahooBars } = {}) {
  const points = [];
  const errors = [];
  for (const c of candidateContracts(inst, nowSec, 9)) {
    if (points.length >= maxPoints) break;
    try {
      const bars = await fetcher(c.symbol, { interval: '1d', range: '1mo' });
      const last = bars[bars.length - 1];
      if (!last || last.ts < nowSec - 7 * DAY) continue; // 已到期或无报价
      const recent = bars.slice(-3);
      points.push({ ...c, close: last.close, ts: last.ts, volume: Math.round(recent.reduce((s, b) => s + b.volume, 0) / recent.length) });
    } catch (e) {
      errors.push(`${c.symbol}: ${e.message}`);
    }
  }
  const active = points.slice(0, 3).reduce((best, p) => (!best || p.volume > best.volume ? p : best), null);
  return { points, active, errors };
}

/** 期限结构指标 */
export function curveMetrics(points) {
  if (!points || points.length < 2) return null;
  const [f, n] = points;
  const last = points[points.length - 1];
  const spreadPct = (n.close / f.close - 1) * 100;
  const gap = Math.max(1, monthsBetween(f.month, n.month));
  const span = Math.max(1, monthsBetween(f.month, last.month));
  const structure = spreadPct > 0.15 ? '升水（Contango）' : spreadPct < -0.15 ? '贴水（Backwardation）' : '平坦';
  return {
    front: f.contract,
    next: n.contract,
    spread_pct: round(spreadPct, 3),
    structure,
    // 多头持有到期滚动的年化收益：贴水为正、升水为负
    roll_yield_ann_pct: round((-spreadPct * 12) / gap, 2),
    curve_slope_ann_pct: round(((last.close / f.close - 1) * 100 * 12) / span, 2),
  };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * 每日更新期限结构（cron 按 4 组错峰，每组 3 个品种）。主力合约变化时，
 * 回填新主力 3 个月的小时线，保证市场反应计算有足够的历史基线。
 */
export async function updateCurves(env, { group = null, nowSec = Math.floor(Date.now() / 1000), fetcher = fetchYahooBars } = {}) {
  const list = group === null ? INSTRUMENTS : INSTRUMENTS.filter((_, i) => i % 4 === group);
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const report = [];
  for (const inst of list) {
    const { points, active, errors } = await resolveCurve(inst, nowSec, { fetcher });
    if (!points.length) {
      report.push({ instrument: inst.key, error: errors[0] || '没有找到在交易的合约' });
      continue;
    }
    const metrics = curveMetrics(points);
    await env.DB.prepare('INSERT OR REPLACE INTO curves (instrument, day, payload) VALUES (?, ?, ?)')
      .bind(inst.key, day, JSON.stringify({ points, metrics, active: active.contract })).run();

    const prev = await env.DB.prepare('SELECT active_contract FROM instrument_state WHERE instrument = ?').bind(inst.key).first();
    let rolled = false;
    if (prev?.active_contract !== active.contract) {
      rolled = true;
      await env.DB.prepare(
        `INSERT INTO instrument_state (instrument, active_contract, active_symbol, rolled_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(instrument) DO UPDATE SET active_contract = excluded.active_contract, active_symbol = excluded.active_symbol, rolled_at = excluded.rolled_at`,
      ).bind(inst.key, active.contract, active.symbol, new Date(nowSec * 1000).toISOString()).run();
      try {
        const bars = await fetcher(active.symbol, { interval: '60m', range: '3mo' });
        const stmt = env.DB.prepare('INSERT OR REPLACE INTO prices (instrument, contract, ts, close) VALUES (?, ?, ?, ?)');
        for (let i = 0; i < bars.length; i += 400) await env.DB.batch(bars.slice(i, i + 400).map((b) => stmt.bind(inst.key, active.contract, b.ts, b.close)));
      } catch (e) {
        errors.push(`回填 ${active.symbol}: ${e.message}`);
      }
    }
    report.push({ instrument: inst.key, contracts: points.length, active: active.contract, rolled, structure: metrics?.structure, errors: errors.length ? errors : undefined });
  }
  return report;
}

export async function activeContract(env, key) {
  const s = await env.DB.prepare('SELECT active_contract, active_symbol FROM instrument_state WHERE instrument = ?').bind(key).first();
  return s?.active_contract ? { contract: s.active_contract, symbol: s.active_symbol } : { contract: 'cont', symbol: byKey[key].yahoo };
}
