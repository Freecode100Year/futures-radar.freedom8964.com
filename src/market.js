// 行情采集 + 市场反应计算 + "市场冲击"分数校准
import { INSTRUMENTS, byKey } from './instruments.js';
import { computeSeverity, levelOf } from './rubric.js';
import { fetchYahooBars, activeContract } from './contracts.js';

const HOUR = 3600;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// =====================================================================
// 1. 数据源
// =====================================================================

export function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'Yahoo 返回为空');
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (Number.isFinite(close[i])) out.push({ ts: ts[i], close: close[i] });
  return out;
}

export function parseTwelve(json) {
  if (json?.status !== 'ok') throw new Error(json?.message || 'Twelve Data 返回错误');
  return (json.values || [])
    .map((v) => ({ ts: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000), close: Number(v.close) }))
    .filter((p) => Number.isFinite(p.close) && Number.isFinite(p.ts))
    .reverse();
}

async function fetchYahoo(symbol, backfill) {
  return (await fetchYahooBars(symbol, { interval: '60m', range: backfill ? '3mo' : '5d' })).map(({ ts, close }) => ({ ts, close }));
}

async function fetchTwelve(inst, backfill, apiKey) {
  const q = new URLSearchParams({ symbol: inst.twelve, interval: '1h', outputsize: backfill ? '2000' : '24', timezone: 'UTC', apikey: apiKey });
  const res = await fetch(`https://api.twelvedata.com/time_series?${q}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  return parseTwelve(await res.json());
}

/** 按配置的优先顺序尝试数据源，失败时切换到另一个 */
async function fetchSeries(env, inst, backfill, active) {
  const order = env.MARKET_PROVIDER === 'twelvedata' ? ['twelve', 'yahoo'] : ['yahoo', 'twelve'];
  const errors = [];
  for (const p of order) {
    try {
      // Yahoo：主力合约（例如 CLZ26.NYM）；尚未识别主力时用连续合约 CL=F
      if (p === 'yahoo') return { provider: 'yahoo', contract: active.contract, points: await fetchYahoo(active.symbol, backfill) };
      // Twelve Data：现货价近似，单独记为 spot，不与期货合约混算
      if (p === 'twelve' && inst.twelve && env.TWELVEDATA_API_KEY) return { provider: 'twelvedata', contract: 'spot', points: await fetchTwelve(inst, backfill, env.TWELVEDATA_API_KEY) };
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ') || '没有可用的数据源');
}

/**
 * 采集行情。cron 每 15 分钟调用一次，品种按 4 组错峰，每个品种每小时更新一次
 * （也满足 Twelve Data 免费版每分钟 8 次的限制）。
 */
export async function fetchMarket(env, { backfill = false, group = null } = {}) {
  const list = group === null ? INSTRUMENTS : INSTRUMENTS.filter((_, i) => i % 4 === group);
  const report = [];
  for (const inst of list) {
    try {
      const active = await activeContract(env, inst.key);
      const { provider, contract, points } = await fetchSeries(env, inst, backfill, active);
      // 只写新K线（以及最后一根可能未收盘的K线），避免每小时重写 5 天数据（D1 免费版每天只有 10 万行写入）
      const last = backfill ? null : (await env.DB.prepare('SELECT MAX(ts) AS t FROM prices WHERE instrument = ? AND contract = ?').bind(inst.key, contract).first())?.t;
      const fresh = last ? points.filter((p) => p.ts >= last) : points;
      const stmt = env.DB.prepare('INSERT OR REPLACE INTO prices (instrument, contract, ts, close) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < fresh.length; i += 400) {
        await env.DB.batch(fresh.slice(i, i + 400).map((p) => stmt.bind(inst.key, contract, p.ts, p.close)));
      }
      report.push({ instrument: inst.key, provider, contract, points: points.length, written: fresh.length });
    } catch (e) {
      report.push({ instrument: inst.key, error: e.message });
    }
  }
  return report;
}

// =====================================================================
// 2. 市场反应（纯函数，便于测试）
// =====================================================================

const WINDOWS = [4, 24, 72]; // 小时

function change(kind, a, b) {
  return kind === 'yield' ? b - a : Math.log(b / a);
}

function stdev(xs) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * 稳健波动率：1.4826 × 中位数绝对偏差（MAD）。基线里偶尔的跳空（数据报价、休市后开盘）
 * 不会把波动率抬高，从而避免低估事件后的异动。MAD 为 0（大量无变动K线）时退回标准差。
 */
export function robustSigma(xs) {
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med))) * 1.4826;
  return mad > 0 ? mad : stdev(xs);
}

/**
 * 同一品种可能存了多个合约（主力换月前后）。选在 [t0-30天, t0+72h] 内K线最多的合约，
 * 平局取较新的合约。保证基线与事件窗口来自同一个合约，不会把换月价差误当成异动。
 */
export function pickContractSeries(rows, t0) {
  const lo = t0 - 30 * 24 * HOUR, hi = t0 + 72 * HOUR;
  const groups = {};
  for (const r of rows) (groups[r.contract ?? ''] ||= []).push(r);
  let best = null, bestN = -1;
  for (const [c, list] of Object.entries(groups)) {
    const n = list.filter((r) => r.ts >= lo && r.ts <= hi).length;
    if (n > bestN || (n === bestN && c > best)) {
      best = c;
      bestN = n;
    }
  }
  return { contract: best, series: best === null ? [] : groups[best].sort((a, b) => a.ts - b.ts) };
}

/**
 * series: 按时间升序的 [{ts, close}]；t0、now 为 unix 秒。
 * z = 窗口变化 / (事件前 30 天小时波动率 × √窗口内K线数)。
 * 用K线数而不是日历小时，周末、休市自然被排除。
 */
export function computeReaction(series, t0, now, kind = 'price', { baselineDays = 30, minBaseline = 50 } = {}) {
  const base = series.filter((p) => p.ts <= t0 && p.ts >= t0 - baselineDays * 24 * HOUR);
  if (base.length < minBaseline) return { status: 'insufficient_history', baseline_bars: base.length };
  const p0 = base[base.length - 1];
  const rets = [];
  for (let i = 1; i < base.length; i++) rets.push(change(kind, base[i - 1].close, base[i].close));
  const sigma = robustSigma(rets);
  if (!(sigma > 0)) return { status: 'zero_volatility' };

  const after = series.filter((p) => p.ts > t0 && p.ts <= Math.min(now, t0 + 72 * HOUR));
  const windows = {};
  let zMax = 0;
  for (const h of WINDOWS) {
    const end = t0 + h * HOUR;
    const bars = after.filter((p) => p.ts <= end);
    const complete = now >= end;
    if (!bars.length) {
      windows[`h${h}`] = { n: 0, complete };
      continue;
    }
    const last = bars[bars.length - 1];
    const c = change(kind, p0.close, last.close);
    const z = c / (sigma * Math.sqrt(bars.length));
    windows[`h${h}`] = { n: bars.length, complete, change: c, z: round(z, 2) };
    if (Math.abs(z) > Math.abs(zMax)) zMax = z;
  }

  const latest = after.length ? change(kind, p0.close, after[after.length - 1].close) : 0;
  // 图表用：锚点前 24 小时到后 72 小时，相对锚点的变化
  const chart = series
    .filter((p) => p.ts >= t0 - 24 * HOUR && p.ts <= Math.min(now, t0 + 72 * HOUR))
    .map((p) => [p.ts, round(kind === 'yield' ? (p.close - p0.close) * 100 : (p.close / p0.close - 1) * 100, 3)]);

  return {
    status: after.length ? 'ok' : 'waiting',
    p0: p0.close,
    sigma: round(sigma, 6),
    baseline_bars: base.length,
    windows,
    z: round(zMax, 2),
    latest_change: round(latest, 6),
    chart: downsample(chart, 120),
  };
}

function round(x, d) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

/**
 * 实测分（0-5），刻度与 rubric 的 market_shock 对齐：
 * |z|<1 →0；<2 →1 单一资产轻微；<3 →2 明显波动；<4.5 →3；<7 →4 剧烈；≥7 →5。
 * 至少 3 个资产 |z|≥2 时（多类资产联动）不低于 3。
 */
export function observedShockScore(zs) {
  const abs = zs.filter(Number.isFinite).map(Math.abs);
  if (!abs.length) return null;
  const m = Math.max(...abs);
  let s = m < 1 ? 0 : m < 2 ? 1 : m < 3 ? 2 : m < 4.5 ? 3 : m < 7 ? 4 : 5;
  if (abs.filter((z) => z >= 2).length >= 3) s = Math.max(s, 3);
  return s;
}

/** 模型方向 vs 实际变化。|z|<1 视为"不显著"，不计入命中率 */
export function judgeDirection(expected, reaction) {
  if (!reaction || reaction.status !== 'ok' || !expected || expected === '不确定') return 'unscored';
  const z = reaction.z;
  if (expected === '波动加剧') return Math.abs(z) >= 2 ? 'hit' : Math.abs(z) < 1 ? 'insignificant' : 'miss';
  if (Math.abs(z) < 1) return 'insignificant';
  const up = z > 0;
  return (expected === '上涨') === up ? 'hit' : 'miss';
}

/**
 * 融合权重：模型列出了对应资产 → 最高 0.6；只能用核心资产兜底 → 最高 0.3。
 * 24 小时窗口走完拿满权重，只有 4 小时窗口时拿 40%，否则为 0（等待数据）。
 */
export function blendWeight(reactions, linked) {
  const ok = reactions.filter((r) => r.status === 'ok');
  if (!ok.length) return 0;
  const cap = linked ? 0.6 : 0.3;
  if (ok.some((r) => r.windows.h24?.complete && r.windows.h24.n > 0)) return cap;
  if (ok.some((r) => r.windows.h4?.complete && r.windows.h4.n > 0)) return cap * 0.4;
  return 0;
}

// =====================================================================
// 3. 事件校准
// =====================================================================

/** 根据分析结果和价格数据算出事件的市场反应与校准后的分数（纯函数） */
export function calibrate(analysis, firstSeenIso, pricesByKey, nowSec, { preHours = 2 } = {}) {
  const t0 = Math.floor(Date.parse(firstSeenIso) / 1000) - preHours * HOUR; // 新闻常滞后于市场，锚点前移
  const expected = new Map();
  for (const a of analysis.impact?.assets || []) {
    if (a.instrument && byKey[a.instrument] && !expected.has(a.instrument)) expected.set(a.instrument, a.direction);
  }
  const linked = expected.size > 0;
  const keys = linked ? [...expected.keys()] : INSTRUMENTS.filter((i) => i.core).map((i) => i.key);

  const rows = keys.map((key) => {
    const inst = byKey[key];
    const { contract, series } = pickContractSeries(pricesByKey[key] || [], t0);
    const r = computeReaction(series, t0, nowSec, inst.kind);
    return { key, name: inst.name, kind: inst.kind, contract, expected: expected.get(key) || null, verdict: judgeDirection(expected.get(key), r), ...r };
  });

  const ok = rows.filter((r) => r.status === 'ok');
  const observed = observedShockScore(ok.map((r) => r.z));
  const modelScore = Number(analysis.scores?.market_shock?.score ?? 0);
  const weight = observed === null ? 0 : blendWeight(rows, linked);
  const blended = round(modelScore * (1 - weight) + (observed ?? modelScore) * weight, 1);

  const scores = { ...analysis.scores, market_shock: { ...analysis.scores?.market_shock, score: blended } };
  const severity = computeSeverity(scores);
  const final = nowSec >= t0 + 72 * HOUR;
  const tally = (v) => rows.filter((r) => r.verdict === v).length;

  return {
    anchor: new Date(t0 * 1000).toISOString(),
    linked,
    final,
    model_score: modelScore,
    observed_score: observed,
    weight,
    blended_score: blended,
    model_severity: analysis.severity ?? computeSeverity(analysis.scores),
    severity,
    level: levelOf(severity),
    hits: tally('hit'),
    misses: tally('miss'),
    insignificant: tally('insignificant'),
    instruments: rows,
  };
}

/** 读取价格并校准一批事件；在每次深度分析后和每小时 cron 中调用 */
export async function calibrateEvents(env, eventIds = null, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  let events;
  if (eventIds) {
    const ph = eventIds.map(() => '?').join(',');
    events = (await env.DB.prepare(`SELECT id, first_seen_at, severity FROM events WHERE id IN (${ph}) AND status = 'analyzed'`).bind(...eventIds).all()).results;
  } else {
    events = (await env.DB.prepare("SELECT id, first_seen_at, severity FROM events WHERE status = 'analyzed' AND market_final = 0").all()).results;
  }
  if (!events.length) return [];

  const minT0 = Math.min(...events.map((e) => Date.parse(e.first_seen_at) / 1000)) - 32 * 24 * HOUR;
  const { results: prices } = await env.DB.prepare('SELECT instrument, contract, ts, close FROM prices WHERE ts >= ? ORDER BY ts').bind(Math.floor(minT0)).all();
  const byInst = {};
  for (const p of prices) (byInst[p.instrument] ||= []).push(p);

  const preHours = num(env.MARKET_PRE_HOURS, 2);
  const out = [];
  for (const ev of events) {
    const row = await env.DB.prepare('SELECT payload FROM analyses WHERE event_id = ? ORDER BY created_at DESC LIMIT 1').bind(ev.id).first();
    if (!row) continue;
    const m = calibrate(JSON.parse(row.payload), ev.first_seen_at, byInst, nowSec, { preHours });
    const ts = new Date(nowMs).toISOString();
    const stmts = [
      env.DB.prepare('UPDATE events SET severity = ?, level = ?, model_severity = ?, market = ?, market_final = ?, market_calibrated_at = ? WHERE id = ?')
        .bind(m.severity, m.level, m.model_severity, JSON.stringify(m), m.final ? 1 : 0, ts, ev.id),
    ];
    if (Math.abs((ev.severity ?? 0) - m.severity) >= 0.5) {
      stmts.push(env.DB.prepare("INSERT INTO severity_log (event_id, ts, severity, source) VALUES (?, ?, ?, 'market')").bind(ev.id, ts, m.severity));
    }
    await env.DB.batch(stmts);
    out.push({ id: ev.id, severity: m.severity, observed: m.observed_score, weight: m.weight, final: m.final });
  }
  return out;
}

/** 模型校准统计：方向命中率、市场冲击分的偏差 */
export async function calibrationStats(env) {
  const { results } = await env.DB.prepare('SELECT id, market FROM events WHERE market IS NOT NULL ORDER BY last_updated_at DESC LIMIT 500').all();
  const perInst = {};
  let hits = 0, misses = 0, insignificant = 0;
  const diffs = [];
  for (const r of results) {
    const m = JSON.parse(r.market);
    hits += m.hits;
    misses += m.misses;
    insignificant += m.insignificant;
    if (m.observed_score !== null && m.weight > 0) diffs.push(m.model_score - m.observed_score);
    for (const i of m.instruments) {
      if (!['hit', 'miss'].includes(i.verdict)) continue;
      const s = (perInst[i.key] ||= { name: i.name, hit: 0, miss: 0 });
      s[i.verdict]++;
    }
  }
  const mean = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null);
  return {
    events: results.length,
    direction: { hits, misses, insignificant, hit_rate: hits + misses ? round(hits / (hits + misses), 3) : null },
    market_shock: { n: diffs.length, bias: mean(diffs), mae: mean(diffs.map(Math.abs)) },
    by_instrument: Object.entries(perInst)
      .map(([key, s]) => ({ key, ...s, hit_rate: round(s.hit / (s.hit + s.miss), 3) }))
      .sort((a, b) => b.hit + b.miss - (a.hit + a.miss)),
  };
}
