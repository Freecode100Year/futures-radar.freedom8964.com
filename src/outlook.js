// 小时行情与"未来一小时风险展望"。
//
// 展望给的是统计区间，不是涨跌预测：
//   1. 用近约 70 天的小时收益率，按美东时段（0–23 点）分别估计波动率；样本少的时段向整体波动率收缩。
//   2. 近 24 小时实际波动 / 长期波动 = 波动状态系数（限制在 0.7–1.6），放大或缩小区间。
//   3. 窗口内有数据发布（EIA、USDA 等）时，改用历史上"同一星期几、同一小时"的波动率（不低于平常时段）。
//   4. 区间宽度用标准化收益率的经验分位数（而不是正态分布的 1σ/2σ），这样肥尾也能体现出来。
//   5. 窗口结束后用实际价格核对是否落在区间内，公开命中率：68% 区间长期命中率应接近 68%。
// AI 只负责写情景（"如果……可能……"），不给方向，输出里出现交易指令类词语的条目会被丢弃。
import { INSTRUMENTS, byKey } from './instruments.js';
import { isOpen, etParts } from './sessions.js';
import { upcomingEvents } from './calendar.js';
import { generate, chainFor } from './llm.js';
import { relatedEvents } from './futures.js';

const HOUR = 3600;
const DAY = 86400;
const HISTORY_DAYS = 70;
const SHRINK = 10; // 某时段样本数为 n 时，方差 = (n·时段方差 + 10·整体方差) / (n + 10)

const isBarStart = (ts) => ts % 1800 === 0;
/** 一条价格记录对应的时间：完整小时K线的收盘在开盘后 1 小时；实时点就是它自己的时间 */
export const priceTime = (row) => (isBarStart(row.ts) ? row.ts + HOUR : row.ts);
const etHour = (sec) => Math.floor(etParts(new Date(sec * 1000)).minute / 60);
const etDay = (sec) => etParts(new Date(sec * 1000)).day;
const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const parse = (s, d = null) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

/** 读取某品种最近的小时数据（只用最新那个合约，避免换月时价格跳空） */
export async function loadHourly(env, key, sinceSec) {
  const c = await env.DB.prepare('SELECT contract FROM prices WHERE instrument = ? AND ts >= ? ORDER BY ts DESC LIMIT 1').bind(key, sinceSec).first();
  if (!c) return { contract: null, rows: [] };
  const { results } = await env.DB.prepare('SELECT ts, open, high, low, close FROM prices WHERE instrument = ? AND contract = ? AND ts >= ? ORDER BY ts')
    .bind(key, c.contract, sinceSec).all();
  return { contract: c.contract, rows: results };
}

/**
 * 整理成小时K线：完整K线（时间戳在整点或半点）+ 最后一根未收盘K线（最新的实时点）。
 * 早期数据没有存开高低，用前一根收盘作开盘、开收较大/较小值作高低。
 */
export function hourlyCandles(rows, limit = 72) {
  const bars = rows.filter((r) => isBarStart(r.ts));
  const live = rows.filter((r) => !isBarStart(r.ts)).at(-1);
  const lastBar = bars.at(-1);
  const list = bars.map((r) => ({ ...r, partial: false }));
  if (live && (!lastBar || live.ts >= lastBar.ts + HOUR)) {
    const start = lastBar ? lastBar.ts + HOUR * Math.floor((live.ts - lastBar.ts) / HOUR) : Math.floor(live.ts / HOUR) * HOUR;
    list.push({ ...live, ts: start, live_ts: live.ts, partial: true });
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const prev = i > 0 ? list[i - 1].close : null;
    const o = r.open ?? prev ?? r.close;
    out.push({
      t: r.ts,
      o: round(o, 6),
      h: round(r.high ?? Math.max(o, r.close), 6),
      l: round(r.low ?? Math.min(o, r.close), 6),
      c: round(r.close, 6),
      chg_pct: prev ? round((r.close / prev - 1) * 100, 3) : null,
      ...(r.partial ? { partial: true, live_ts: r.live_ts } : {}),
    });
  }
  return out.slice(-limit);
}

const rms = (xs) => (xs.length ? Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length) : null);
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};

/** 由完整小时K线估计：各时段波动率、同星期同小时波动率、标准化收益率分位数、近期波动状态 */
export function hourStats(rows) {
  const bars = rows.filter((r) => isBarStart(r.ts));
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].ts - bars[i - 1].ts !== HOUR || !(bars[i - 1].close > 0)) continue;
    rets.push({ ts: bars[i].ts, r: Math.log(bars[i].close / bars[i - 1].close) });
  }
  if (rets.length < 100) return null;
  const all0 = rms(rets.map((x) => x.r));
  const cap = 6 * all0; // 截尾：单根极端K线（例如换月、坏数据）不主导时段波动率
  const clip = (r) => Math.max(-cap, Math.min(cap, r));
  const all = rms(rets.map((x) => clip(x.r)));
  const byHour = {}, byDayHour = {};
  for (const x of rets) {
    const h = etHour(x.ts), k = `${etDay(x.ts)}-${h}`;
    (byHour[h] ||= []).push(clip(x.r));
    (byDayHour[k] ||= []).push(clip(x.r));
  }
  const hour = {};
  for (let h = 0; h < 24; h++) {
    const xs = byHour[h] || [];
    const v = xs.length ? rms(xs) ** 2 : 0;
    hour[h] = { n: xs.length, sigma: Math.sqrt((xs.length * v + SHRINK * all * all) / (xs.length + SHRINK)) };
  }
  const dayHour = Object.fromEntries(Object.entries(byDayHour).map(([k, xs]) => [k, { n: xs.length, sigma: rms(xs) }]));
  const z = rets.map((x) => Math.abs(x.r / hour[etHour(x.ts)].sigma)).sort((a, b) => a - b);
  const recent = rets.slice(-24).map((x) => clip(x.r) / hour[etHour(x.ts)].sigma);
  const regime = recent.length >= 12 ? Math.min(1.6, Math.max(0.7, rms(recent))) : 1;
  return {
    n: rets.length,
    sigma_all: all,
    hour,
    dayHour,
    q68: z.length >= 200 ? quantile(z, 0.6827) : 1,
    q95: z.length >= 200 ? quantile(z, 0.9545) : 1.96,
    regime,
  };
}

/** 窗口内是否开盘（看窗口里每 5 分钟） */
function openMinutes(session, start, end) {
  const out = [];
  for (let t = start; t < end; t += 300) if (isOpen(session, new Date((t + 150) * 1000))) out.push(t);
  return out;
}

/** 与品种相关的数据发布：周期性事件按 instruments 匹配；手动添加且未指定品种的视为影响全部 */
function eventsFor(key, events, from, to) {
  return events.filter((e) => {
    const t = Date.parse(e.ts) / 1000;
    if (!(t > from && t <= to)) return false;
    if (e.instruments?.length) return e.instruments.includes(key);
    return e.source === 'custom';
  });
}

/**
 * 计算一个品种的未来一小时展望。
 * @returns {{status:'open'|'closed'|'nodata', ...}}
 */
export function computeOutlook(inst, rows, { nowSec, events = [], stats = hourStats(rows) }) {
  const windowStart = Math.floor(nowSec / HOUR) * HOUR;
  const windowEnd = windowStart + HOUR;
  const session = inst.spec.session;
  const base0 = { instrument: inst.key, window_start: windowStart, window_end: windowEnd };
  if (!openMinutes(session, windowStart, windowEnd).length) return { ...base0, status: 'closed' };
  if (!stats) return { ...base0, status: 'nodata', reason: '小时线不足 100 根' };
  const pts = rows.map((r) => ({ t: priceTime(r), close: r.close })).filter((p) => p.t <= nowSec).sort((a, b) => a.t - b.t);
  const base = pts.at(-1);
  if (!base) return { ...base0, status: 'nodata', reason: '没有最新价格' };

  // 从基准价时间到窗口结束要覆盖几个小时（数据延迟 → 通常 1–2 小时），只计开盘的小时；最多 3 小时
  const steps = Math.min(3, Math.max(1, Math.ceil((windowEnd - base.t) / HOUR)));
  const evs = eventsFor(inst.key, events, Math.max(base.t, windowStart - (steps - 1) * HOUR), windowEnd);
  let variance = 0;
  let eventAdj = null;
  for (let j = 1; j <= steps; j++) {
    const s = windowEnd - j * HOUR;
    if (!openMinutes(session, s, s + HOUR).length) continue;
    let sig = stats.hour[etHour(s)].sigma * stats.regime;
    const inHour = evs.filter((e) => {
      const t = Date.parse(e.ts) / 1000;
      return t > s && t <= s + HOUR;
    });
    if (inHour.length) {
      const dh = stats.dayHour[`${etDay(s)}-${etHour(s)}`];
      const imp = Math.max(...inHour.map((e) => e.importance || 2));
      // 有足够历史（≥5 次）就用同星期同小时的实际波动；否则按重要性放大 1.2–1.5 倍（经验值）
      const evSig = dh && dh.n >= 5 ? dh.sigma : stats.hour[etHour(s)].sigma * (imp >= 3 ? 1.5 : 1.2);
      if (evSig > sig) {
        eventAdj = { factor: round(evSig / sig, 2), basis: dh && dh.n >= 5 ? `历史同时段 ${dh.n} 次` : '经验放大' };
        sig = evSig;
      }
    }
    variance += sig * sig;
  }
  const sigma = Math.sqrt(variance);
  const band = (q) => [base.close * Math.exp(-q * sigma), base.close * Math.exp(q * sigma)];
  const [lo68, hi68] = band(stats.q68);
  const [lo95, hi95] = band(stats.q95);
  return {
    ...base0,
    status: 'open',
    made_at: nowSec,
    base_price: round(base.close, 6),
    base_ts: base.t,
    horizon_h: steps,
    sigma_pct: round(sigma * 100, 4),
    lo68: round(lo68, 6), hi68: round(hi68, 6),
    lo95: round(lo95, 6), hi95: round(hi95, 6),
    width68_pct: round(stats.q68 * sigma * 100, 3),
    width95_pct: round(stats.q95 * sigma * 100, 3),
    regime: round(stats.regime, 2),
    event_adj: eventAdj,
    events: evs.map((e) => ({ ts: e.ts, title: e.title, importance: e.importance })),
    samples: stats.n,
    stale_min: Math.round((nowSec - base.t) / 60),
  };
}

/** 每整点：为所有开盘品种生成本小时的展望 */
export async function makeOutlooks(env, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const events = await upcomingEvents(env, { nowMs: (nowSec - 4 * HOUR) * 1000, days: 1 });
  const out = [];
  for (const inst of INSTRUMENTS) {
    try {
      const { contract, rows } = await loadHourly(env, inst.key, nowSec - HISTORY_DAYS * DAY);
      const o = computeOutlook(inst, rows, { nowSec, events });
      if (o.status === 'open') {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO hourly_outlook (instrument, window_start, made_at, contract, base_price, base_ts, horizon_h, sigma_pct, lo68, hi68, lo95, hi95, events, regime)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(inst.key, o.window_start, o.made_at, contract, o.base_price, o.base_ts, o.horizon_h, o.sigma_pct, o.lo68, o.hi68, o.lo95, o.hi95,
          JSON.stringify({ list: o.events, adj: o.event_adj, w68: o.width68_pct, w95: o.width95_pct, stale_min: o.stale_min }), o.regime).run();
      }
      out.push({ instrument: inst.key, status: o.status, ...(o.status === 'open' ? { w68: o.width68_pct, events: o.events.length } : { reason: o.reason }) });
    } catch (e) {
      out.push({ instrument: inst.key, error: e.message });
    }
  }
  return out;
}

/**
 * 核对已结束的窗口：取窗口内最后开盘时刻附近（20 分钟内）的价格。
 * 数据有延迟，所以要等窗口结束后出现更晚的价格才核对；结束 3 小时还没数据就记为无法核对。
 */
export async function evaluateOutlooks(env, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const { results } = await env.DB.prepare('SELECT * FROM hourly_outlook WHERE evaluated_at IS NULL AND window_start <= ? ORDER BY window_start LIMIT 60')
    .bind(nowSec - HOUR).all();
  const out = [];
  for (const o of results) {
    const inst = byKey[o.instrument];
    const end = o.window_start + HOUR;
    const opens = inst ? openMinutes(inst.spec.session, o.window_start, end) : [];
    const lastOpen = opens.length ? opens.at(-1) + 300 : end;
    const { results: rows } = await env.DB.prepare('SELECT ts, close FROM prices WHERE instrument = ? AND contract = ? AND ts >= ? AND ts <= ?')
      .bind(o.instrument, o.contract, end - 3 * HOUR, end + 4 * HOUR).all();
    const pts = rows.map((r) => ({ t: priceTime(r), close: r.close }));
    const arrived = pts.some((p) => p.t >= lastOpen);
    const giveUp = nowSec >= end + 3 * HOUR;
    if (!arrived && !giveUp) continue;
    const cand = pts.filter((p) => p.t <= lastOpen + 300 && p.t >= lastOpen - 1200).sort((a, b) => b.t - a.t)[0];
    const hit68 = cand ? (cand.close >= o.lo68 && cand.close <= o.hi68 ? 1 : 0) : null;
    const hit95 = cand ? (cand.close >= o.lo95 && cand.close <= o.hi95 ? 1 : 0) : null;
    await env.DB.prepare('UPDATE hourly_outlook SET actual = ?, actual_ts = ?, hit68 = ?, hit95 = ?, evaluated_at = ? WHERE instrument = ? AND window_start = ?')
      .bind(cand?.close ?? null, cand?.t ?? null, hit68, hit95, nowSec, o.instrument, o.window_start).run();
    out.push({ instrument: o.instrument, window_start: o.window_start, hit68, hit95 });
  }
  return out;
}

function rowOut(r) {
  const ex = parse(r.events, {});
  return {
    instrument: r.instrument,
    window_start: new Date(r.window_start * 1000).toISOString(),
    window_end: new Date((r.window_start + HOUR) * 1000).toISOString(),
    made_at: new Date(r.made_at * 1000).toISOString(),
    contract: r.contract,
    base_price: r.base_price,
    base_time: new Date(r.base_ts * 1000).toISOString(),
    stale_min: ex.stale_min ?? null,
    horizon_h: r.horizon_h,
    sigma_pct: r.sigma_pct,
    lo68: r.lo68, hi68: r.hi68, lo95: r.lo95, hi95: r.hi95,
    width68_pct: ex.w68 ?? null, width95_pct: ex.w95 ?? null,
    regime: r.regime,
    events: ex.list || [],
    event_adj: ex.adj || null,
    actual: r.actual,
    hit68: r.hit68, hit95: r.hit95,
    evaluated: r.evaluated_at !== null && r.evaluated_at !== undefined,
  };
}

/** 命中率统计（近 days 天、已核对的窗口） */
export async function outlookTrack(env, { days = 30, nowSec = Math.floor(Date.now() / 1000), key = null } = {}) {
  const since = nowSec - days * DAY;
  const { results } = await env.DB.prepare(
    `SELECT instrument, COUNT(*) AS n, SUM(hit68) AS h68, SUM(hit95) AS h95,
       SUM(CASE WHEN actual > hi68 THEN 1 ELSE 0 END) AS above, SUM(CASE WHEN actual < lo68 THEN 1 ELSE 0 END) AS below
     FROM hourly_outlook WHERE evaluated_at IS NOT NULL AND hit68 IS NOT NULL AND window_start >= ? GROUP BY instrument`,
  ).bind(since).all();
  const rate = (h, n) => (n ? round(h / n, 3) : null);
  const by = Object.fromEntries(results.map((r) => [r.instrument, r]));
  const per = INSTRUMENTS.filter((i) => !key || i.key === key).map((i) => {
    const r = by[i.key] || { n: 0, h68: 0, h95: 0, above: 0, below: 0 };
    return { key: i.key, name: i.name, n: r.n, hit68: rate(r.h68, r.n), hit95: rate(r.h95, r.n), above68: r.above, below68: r.below };
  });
  const tot = results.reduce((a, r) => ({ n: a.n + r.n, h68: a.h68 + r.h68, h95: a.h95 + r.h95 }), { n: 0, h68: 0, h95: 0 });
  return { days, target68: 0.683, target95: 0.954, overall: { n: tot.n, hit68: rate(tot.h68, tot.n), hit95: rate(tot.h95, tot.n) }, by_instrument: per };
}

/** 当前窗口（或最近一个窗口）的展望 + AI 情景 + 命中率 */
export async function getOutlook(env, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const ws = Math.floor(nowSec / HOUR) * HOUR;
  const { results } = await env.DB.prepare(
    `SELECT o.* FROM hourly_outlook o JOIN (SELECT instrument, MAX(window_start) AS w FROM hourly_outlook WHERE window_start >= ? GROUP BY instrument) m
       ON o.instrument = m.instrument AND o.window_start = m.w`,
  ).bind(ws - 2 * HOUR).all();
  const latestWs = results.reduce((a, r) => Math.max(a, r.window_start), 0);
  const com = latestWs ? await env.DB.prepare('SELECT payload, model, created_at FROM hourly_commentary WHERE window_start = ?').bind(latestWs).first() : null;
  const items = Object.fromEntries((parse(com?.payload, {}).items || []).map((x) => [x.instrument, x]));
  const byInst = Object.fromEntries(results.map((r) => [r.instrument, r]));
  return {
    now: new Date(nowSec * 1000).toISOString(),
    window_start: latestWs ? new Date(latestWs * 1000).toISOString() : null,
    commentary_model: com?.model || null,
    commentary_at: com ? new Date(com.created_at * 1000).toISOString() : null,
    instruments: INSTRUMENTS.map((i) => {
      const r = byInst[i.key];
      if (!r) return { instrument: i.key, name: i.name, status: openMinutes(i.spec.session, ws, ws + HOUR).length ? 'pending' : 'closed' };
      return { ...rowOut(r), name: i.name, unit: i.unit, status: r.window_start === ws ? 'current' : 'previous', ai: items[i.key] || null };
    }),
    track: await outlookTrack(env, { nowSec }),
  };
}

/** 品种详情：小时K线 + 当前展望 + 最近 24 个窗口的核对结果 */
export async function getHourly(env, key, { nowSec = Math.floor(Date.now() / 1000), hours = 72 } = {}) {
  const inst = byKey[key];
  if (!inst) return null;
  const { contract, rows } = await loadHourly(env, key, nowSec - HISTORY_DAYS * DAY);
  const candles = hourlyCandles(rows, Math.min(Math.max(hours, 12), 240));
  const { results } = await env.DB.prepare('SELECT * FROM hourly_outlook WHERE instrument = ? ORDER BY window_start DESC LIMIT 24').bind(key).all();
  const ws = Math.floor(nowSec / HOUR) * HOUR;
  const cur = results.find((r) => r.window_start === ws);
  let ai = null;
  if (cur) {
    const com = await env.DB.prepare('SELECT payload FROM hourly_commentary WHERE window_start = ?').bind(ws).first();
    ai = (parse(com?.payload, {}).items || []).find((x) => x.instrument === key) || null;
  }
  const stats = hourStats(rows);
  return {
    instrument: key,
    contract,
    candles,
    current: cur ? { ...rowOut(cur), ai } : null,
    session_open: openMinutes(inst.spec.session, ws, ws + HOUR).length > 0,
    history: results.filter((r) => r.evaluated_at !== null).map(rowOut),
    hour_profile: stats ? Object.entries(stats.hour).map(([h, v]) => ({ hour: Number(h), sigma_pct: round(v.sigma * 100, 4), n: v.n })) : [],
    track: await outlookTrack(env, { nowSec, key }),
  };
}

// ---------------------------------------------------------------------------
// AI 情景解读（每小时一次，所有开盘品种合并为一次请求）
// ---------------------------------------------------------------------------

export const OUTLOOK_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instrument: { type: 'string', enum: INSTRUMENTS.map((i) => i.key) },
          context: { type: 'string', description: '一句话：这一小时值得注意的背景（数据发布、近几小时走势、相关新闻），不超过 40 字' },
          upside: { type: 'string', description: '如果出现什么情况，价格可能向区间上沿甚至上方运动，不超过 40 字' },
          downside: { type: 'string', description: '如果出现什么情况，价格可能向区间下沿甚至下方运动，不超过 40 字' },
          watch: { type: 'string', description: '这一小时最值得盯的一个指标或消息，不超过 25 字' },
        },
        required: ['instrument', 'context', 'upside', 'downside', 'watch'],
      },
    },
  },
  required: ['items'],
};

const OUTLOOK_SYSTEM = `你是国际期货市场的风险分析员，为中文读者写"未来一小时风险情景"。
规则：
1. 系统已经算好每个品种这一小时的统计波动区间、近几小时涨跌和窗口内的数据发布，直接引用，不要自己编数字。
2. 只写情景：上行情景和下行情景都要写，说清"如果发生什么，可能怎样"。不判断哪个情景更可能发生。
3. 不给交易建议：不要出现买入、卖出、做多、做空、开仓、平仓、加仓、减仓、止损、止盈、目标价等词语，也不要给出具体的预测价格。
4. 每个品种一条，简体中文，简短。`;

const BANNED = /(买入|卖出|做多|做空|开仓|建仓|平仓|加仓|减仓|止损|止盈|抄底|逃顶|目标价|看涨|看跌)/;

export async function generateOutlookCommentary(env, { windowStart, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const ws = windowStart ?? Math.floor(nowSec / HOUR) * HOUR;
  if (nowSec >= ws + HOUR - 300) return { skipped: '窗口已结束' };
  const done = await env.DB.prepare('SELECT 1 AS x FROM hourly_commentary WHERE window_start = ?').bind(ws).first();
  if (done) return { skipped: '已生成' };
  const { results } = await env.DB.prepare('SELECT * FROM hourly_outlook WHERE window_start = ?').bind(ws).all();
  if (!results.length) return { skipped: '没有开盘品种' };
  const lines = [];
  for (const r of results) {
    const inst = byKey[r.instrument];
    const ex = parse(r.events, {});
    const { rows } = await loadHourly(env, r.instrument, nowSec - 2 * DAY);
    const c = hourlyCandles(rows, 30);
    const ago = (n) => (c.length > n ? round((c.at(-1).c / c.at(-1 - n).c - 1) * 100, 2) : null);
    const news = await relatedEvents(env, r.instrument, { days: 2, limit: 2, nowSec }).catch(() => []);
    lines.push(`- ${r.instrument}（${inst.name}）：最新 ${r.base_price}（数据延迟约 ${ex.stale_min ?? '?'} 分钟）；近 1 小时 ${ago(1) ?? '—'}%，近 6 小时 ${ago(6) ?? '—'}%，近 24 小时 ${ago(24) ?? '—'}%；`
      + `本小时 68% 统计区间 ${r.lo68}–${r.hi68}（±${ex.w68}%）；波动状态系数 ${r.regime}；`
      + `数据发布：${(ex.list || []).map((e) => e.title).join('、') || '无'}；相关新闻：${news.map((n) => `${n.title}（${n.direction}）`).join('；') || '无'}`);
  }
  const user = `窗口：${new Date(ws * 1000).toISOString()} 起 1 小时（UTC）。\n${lines.join('\n')}\n\n请为以上每个品种各写一条情景。`;
  const r = await generate(env, { chain: chainFor(env, 'outlook'), purpose: 'outlook', maxTokens: 2500, toolName: 'hourly_outlook', schema: OUTLOOK_SCHEMA, system: OUTLOOK_SYSTEM, user });
  const valid = new Set(results.map((x) => x.instrument));
  const seen = new Set();
  const items = (r.data.items || []).filter((x) => {
    if (!valid.has(x.instrument) || seen.has(x.instrument)) return false;
    if (BANNED.test(`${x.context}${x.upside}${x.downside}${x.watch}`)) return false;
    seen.add(x.instrument);
    return true;
  });
  await env.DB.prepare('INSERT OR REPLACE INTO hourly_commentary (window_start, payload, model, created_at) VALUES (?, ?, ?, ?)')
    .bind(ws, JSON.stringify({ items }), r.model, nowSec).run();
  return { window_start: ws, model: r.model, items: items.length, dropped: (r.data.items || []).length - items.length };
}
