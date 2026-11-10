// 小时行情与"未来一小时风险展望"。
//
// 展望给的是统计区间，不是涨跌预测：
//   1. 用近约 70 天的小时收益率，按美东时段（0–23 点）分别估计波动率；样本少的时段向整体波动率收缩。
//   2. 近 24 小时实际波动 / 长期波动 = 波动状态系数（限制在 0.85–2.5），放大或缩小区间。
//   2b. 自适应校准：按该品种最近 300 个已核对窗口的实际命中情况，把区间整体放宽或收窄（intervalScale）。
//   3. 窗口内有数据发布（EIA、USDA 等）时，改用历史上"同一星期几、同一小时"的波动率（不低于平常时段）。
//   4. 区间宽度用标准化收益率的经验分位数（而不是正态分布的 1σ/2σ），这样肥尾也能体现出来。
//   5. 窗口结束后用实际价格核对是否落在区间内，公开命中率：68% 区间长期命中率应接近 68%。
// 方向：统计模型（src/predict.js）给出上涨概率，AI 每小时给出偏涨/偏跌/中性判断，两者分别公开核对命中率，
// 并与"随机猜"和"照抄上一小时方向"对比。不给买卖点、目标价或止损，输出里出现交易指令类词语的条目会被丢弃。
import { INSTRUMENTS, byKey } from './instruments.js';
import { isOpen, etParts } from './sessions.js';
import { upcomingEvents } from './calendar.js';
import { generate, chainFor } from './llm.js';
import { relatedEvents } from './futures.js';
import { quotesWithStatus } from './quotes.js';
import { predictDirection, actualDirection, NO_CALL } from './predict.js';

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
  const rawRegime = recent.length >= 12 ? rms(recent) : 1;
  // 回测（两年、12 个品种）：原来的 0.7–1.6 在平静时把区间收得太窄、剧烈时放得不够，改为 0.85–2.5
  const regime = Math.min(2.5, Math.max(0.85, rawRegime));
  return {
    n: rets.length,
    raw_regime: rawRegime,
    sigma_all: all,
    hour,
    dayHour,
    q68: z.length >= 200 ? quantile(z, 0.6827) : 1,
    q95: z.length >= 200 ? quantile(z, 0.9545) : 1.96,
    regime,
  };
}

/**
 * 自适应校准（共形校准）：看该品种最近已核对的窗口，实际涨跌落在"校准前区间"内的比例是否达标，
 * 不达标就按需要的倍数放宽或收窄。past: [{ r: 实际对数收益, b68, b95: 校准前的半宽（对数） }]，按时间顺序。
 * 样本少时向 1 收缩；倍数限制在 0.8–1.6，避免个别极端窗口把区间拉得过宽。
 */
export const SCALE_WINDOW = 300;
export function intervalScale(past) {
  const xs = past.slice(-SCALE_WINDOW).filter((p) => Number.isFinite(p.r) && p.b68 > 0 && p.b95 > 0);
  if (xs.length < 60) return { k68: 1, k95: 1, n: xs.length };
  const need = (key, q) => quantile(xs.map((p) => Math.abs(p.r) / p[key]).sort((a, b) => a - b), q);
  const shrink = (k) => Math.min(1.6, Math.max(0.8, 1 + (k - 1) * (xs.length / (xs.length + 50))));
  return { k68: shrink(need('b68', 0.6827)), k95: shrink(need('b95', 0.9545)), n: xs.length };
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
export function computeOutlook(inst, rows, { nowSec, events = [], stats = hourStats(rows), latest = null, scale = { k68: 1, k95: 1, n: 0 } }) {
  const windowStart = Math.floor(nowSec / HOUR) * HOUR;
  const windowEnd = windowStart + HOUR;
  const session = inst.spec.session;
  const base0 = { instrument: inst.key, window_start: windowStart, window_end: windowEnd };
  if (!openMinutes(session, windowStart, windowEnd).length) return { ...base0, status: 'closed' };
  if (!stats) return { ...base0, status: 'nodata', reason: '小时线不足 100 根' };
  const pts = rows.map((r) => ({ t: priceTime(r), close: r.close })).filter((p) => p.t <= nowSec).sort((a, b) => a.t - b.t);
  let base = pts.at(-1);
  // 每 5 分钟更新的报价比小时线新，就用它作基准价（同一合约）
  if (latest && latest.t <= nowSec && (!base || latest.t > base.t)) base = latest;
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
  const q68 = stats.q68 * scale.k68, q95 = stats.q95 * scale.k95;
  const [lo68, hi68] = band(q68);
  const [lo95, hi95] = band(q95);
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
    width68_pct: round(q68 * sigma * 100, 3),
    width95_pct: round(q95 * sigma * 100, 3),
    // 校准前的半宽（对数），供以后的自适应校准使用
    base68: round(stats.q68 * sigma, 6),
    base95: round(stats.q95 * sigma, 6),
    scale: { k68: round(scale.k68, 3), k95: round(scale.k95, 3), n: scale.n },
    regime: round(stats.regime, 2),
    event_adj: eventAdj,
    events: evs.map((e) => ({ ts: e.ts, title: e.title, importance: e.importance })),
    samples: stats.n,
    stale_min: Math.round((nowSec - base.t) / 60),
  };
}

/**
 * 读取该品种最近已核对的窗口，算自适应校准倍数。
 * 新版窗口记录了校准前半宽 b68/b95；旧窗口没有，就用当时的实际半宽（当时没有校准，两者相同）。
 */
export async function loadScale(env, key) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT base_price, actual, events FROM hourly_outlook WHERE instrument = ? AND actual IS NOT NULL AND base_price > 0 ORDER BY window_start DESC LIMIT ?',
    ).bind(key, SCALE_WINDOW).all();
    const past = results.reverse().map((r) => {
      const ex = parse(r.events, {});
      return { r: Math.log(r.actual / r.base_price), b68: ex.b68 ?? (ex.w68 > 0 ? ex.w68 / 100 : null), b95: ex.b95 ?? (ex.w95 > 0 ? ex.w95 / 100 : null) };
    });
    return intervalScale(past);
  } catch {
    return { k68: 1, k95: 1, n: 0 };
  }
}

/** 每整点：为所有开盘品种生成本小时的展望 */
export async function makeOutlooks(env, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const events = await upcomingEvents(env, { nowMs: (nowSec - 4 * HOUR) * 1000, days: 1 });
  const { quotes } = await quotesWithStatus(env); // 报价不可用时退回用小时线作基准价
  const out = [];
  for (const inst of INSTRUMENTS) {
    try {
      const { contract, rows } = await loadHourly(env, inst.key, nowSec - HISTORY_DAYS * DAY);
      const q = quotes[inst.key];
      const latest = q && q.contract === contract && q.market_time ? { t: Math.floor(Date.parse(q.market_time) / 1000), close: q.price } : null;
      const o = computeOutlook(inst, rows, { nowSec, events, latest, scale: await loadScale(env, inst.key) });
      let pred = null;
      if (o.status === 'open') {
        pred = predictDirection(rows.filter((r) => r.ts + HOUR <= nowSec), o.window_start); // 只用已收盘的小时K线
        await env.DB.prepare(
          `INSERT OR REPLACE INTO hourly_outlook (instrument, window_start, made_at, contract, base_price, base_ts, horizon_h, sigma_pct, lo68, hi68, lo95, hi95, events, regime, p_up, naive_dir)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(inst.key, o.window_start, o.made_at, contract, o.base_price, o.base_ts, o.horizon_h, o.sigma_pct, o.lo68, o.hi68, o.lo95, o.hi95,
          JSON.stringify({ list: o.events, adj: o.event_adj, w68: o.width68_pct, w95: o.width95_pct, b68: o.base68, b95: o.base95, scale: o.scale, stale_min: o.stale_min, features: pred?.features }), o.regime,
          pred?.p_up ?? null, pred?.naive_dir ?? null).run();
      }
      out.push({ instrument: inst.key, status: o.status, ...(o.status === 'open' ? { w68: o.width68_pct, events: o.events.length, p_up: pred?.p_up ?? null } : { reason: o.reason }) });
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
    // 方向：涨跌幅小于 0.1 倍预期波动算"持平"，不计入；模型概率离 50% 不到 2 个百分点、AI 判"中性"算不表态，也不计入
    const dir = cand ? actualDirection(o.base_price, cand.close, o.sigma_pct) : null;
    const score = (call) => (!dir || !call ? null : call === dir ? 1 : 0);
    const modelCall = o.p_up === null || o.p_up === undefined || Math.abs(o.p_up - 0.5) < NO_CALL ? 0 : o.p_up > 0.5 ? 1 : -1;
    const aiCall = o.ai_lean === '偏涨' ? 1 : o.ai_lean === '偏跌' ? -1 : 0;
    await env.DB.prepare(`UPDATE hourly_outlook SET actual = ?, actual_ts = ?, hit68 = ?, hit95 = ?, dir_actual = ?, model_hit = ?, ai_hit = ?, naive_hit = ?, evaluated_at = ?
      WHERE instrument = ? AND window_start = ?`)
      .bind(cand?.close ?? null, cand?.t ?? null, hit68, hit95, dir, score(modelCall), score(aiCall), score(o.naive_dir || 0), nowSec, o.instrument, o.window_start).run();
    out.push({ instrument: o.instrument, window_start: o.window_start, hit68, hit95, dir });
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
    p_up: r.p_up ?? null,
    features: ex.features || null,
    ai_lean: r.ai_lean ?? null, ai_conf: r.ai_conf ?? null,
    dir_actual: r.dir_actual ?? null, model_hit: r.model_hit ?? null, ai_hit: r.ai_hit ?? null, naive_hit: r.naive_hit ?? null,
    evaluated: r.evaluated_at !== null && r.evaluated_at !== undefined,
  };
}

/** 命中率统计（近 days 天、已核对的窗口） */
export async function outlookTrack(env, { days = 30, nowSec = Math.floor(Date.now() / 1000), key = null } = {}) {
  const since = nowSec - days * DAY;
  const { results } = await env.DB.prepare(
    `SELECT instrument, COUNT(*) AS n, SUM(hit68) AS h68, SUM(hit95) AS h95,
       SUM(CASE WHEN actual > hi68 THEN 1 ELSE 0 END) AS above, SUM(CASE WHEN actual < lo68 THEN 1 ELSE 0 END) AS below,
       SUM(model_hit IS NOT NULL) AS mc, COALESCE(SUM(model_hit), 0) AS mh,
       SUM(ai_hit IS NOT NULL) AS ac, COALESCE(SUM(ai_hit), 0) AS ah,
       SUM(naive_hit IS NOT NULL) AS nc, COALESCE(SUM(naive_hit), 0) AS nh,
       SUM(CASE WHEN dir_actual != 0 AND p_up IS NOT NULL THEN 1 ELSE 0 END) AS bn,
       SUM(CASE WHEN dir_actual != 0 AND p_up IS NOT NULL THEN (p_up - (dir_actual > 0)) * (p_up - (dir_actual > 0)) ELSE 0 END) AS bs
     FROM hourly_outlook WHERE evaluated_at IS NOT NULL AND hit68 IS NOT NULL AND window_start >= ? GROUP BY instrument`,
  ).bind(since).all();
  const rate = (h, n) => (n ? round(h / n, 3) : null);
  const by = Object.fromEntries(results.map((r) => [r.instrument, r]));
  const dirOf = (r) => ({
    model: { calls: r.mc || 0, hits: r.mh || 0, rate: rate(r.mh, r.mc) },
    ai: { calls: r.ac || 0, hits: r.ah || 0, rate: rate(r.ah, r.ac) },
    naive: { calls: r.nc || 0, hits: r.nh || 0, rate: rate(r.nh, r.nc) },
    brier: r.bn ? round(r.bs / r.bn, 4) : null, // 越低越好；永远报 50% 的得分是 0.25
    brier_n: r.bn || 0,
  });
  const zero = { n: 0, h68: 0, h95: 0, above: 0, below: 0, mc: 0, mh: 0, ac: 0, ah: 0, nc: 0, nh: 0, bn: 0, bs: 0 };
  const per = INSTRUMENTS.filter((i) => !key || i.key === key).map((i) => {
    const r = by[i.key] || zero;
    return { key: i.key, name: i.name, n: r.n, hit68: rate(r.h68, r.n), hit95: rate(r.h95, r.n), above68: r.above, below68: r.below, direction: dirOf(r) };
  });
  const tot = results.reduce((a, r) => Object.fromEntries(Object.keys(zero).map((k) => [k, (a[k] || 0) + (r[k] || 0)])), { ...zero });
  return { days, target68: 0.683, target95: 0.954, brier_baseline: 0.25,
    overall: { n: tot.n, hit68: rate(tot.h68, tot.n), hit95: rate(tot.h95, tot.n), direction: dirOf(tot) }, by_instrument: per };
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

// 关注原因：写进提示词，提醒模型这一小时哪些品种有特别情况（每小时都会为所有开盘品种调用一次模型）：
//   · 美东 18:00（夜盘开盘）和 9:00（美股开盘前）；
//   · 本小时有数据发布、近 24 小时波动偏高（系数 ≥ 1.25）、过去 2 小时有相关的已分析事件。
export const FIXED_HOURS_ET = [18, 9];
export const HOT_REGIME = 1.25;

export async function commentaryTargets(env, rows, { ws, nowSec }) {
  const reasons = {};
  const add = (k, why) => (reasons[k] ||= []).push(why);
  if (FIXED_HOURS_ET.includes(etHour(ws))) for (const r of rows) add(r.instrument, '固定时段');
  for (const r of rows) {
    const ex = parse(r.events, {});
    if ((ex.list || []).length) add(r.instrument, '数据发布');
    if (r.regime >= HOT_REGIME) add(r.instrument, '波动偏高');
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT a.payload FROM events e JOIN analyses a ON a.id = (SELECT id FROM analyses WHERE event_id = e.id ORDER BY created_at DESC LIMIT 1)
       WHERE e.status = 'analyzed' AND e.last_updated_at >= ? LIMIT 50`,
    ).bind(new Date((nowSec - 2 * HOUR) * 1000).toISOString()).all();
    const open = new Set(rows.map((r) => r.instrument));
    for (const ev of results) {
      for (const a of parse(ev.payload, {}).impact?.assets || []) if (open.has(a.instrument)) add(a.instrument, '相关新闻');
    }
  } catch {}
  for (const k of Object.keys(reasons)) reasons[k] = [...new Set(reasons[k])];
  return { targets: Object.keys(reasons), reasons };
}

/** AI 自己近 30 天的方向判断战绩，写进提示词（第 4 步：让 AI 知道自己的偏向和命中率） */
export async function aiRecordText(env, nowSec) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT ai_lean, ai_hit FROM hourly_outlook WHERE window_start >= ? AND ai_lean IN ('偏涨', '偏跌') AND ai_hit IS NOT NULL",
    ).bind(nowSec - 30 * DAY).all();
    if (!results.length) return '你的方向判断战绩：近 30 天还没有可核对的记录。';
    const part = (lean) => {
      const xs = results.filter((r) => r.ai_lean === lean);
      return `判${lean} ${xs.length} 次、对 ${xs.filter((r) => r.ai_hit === 1).length} 次`;
    };
    const hits = results.filter((r) => r.ai_hit === 1).length;
    return `你的方向判断战绩（近 30 天，"中性"和持平不计）：${part('偏涨')}；${part('偏跌')}；总命中率 ${Math.round((hits / results.length) * 100)}%（随机猜是 50%）。`;
  } catch {
    return '';
  }
}

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
          lean: { type: 'string', enum: ['偏涨', '偏跌', '中性'], description: '你对这一小时方向的判断；没有明确依据时选"中性"' },
          confidence: { type: 'string', enum: ['低', '中', '高'], description: '判断的把握程度；1 小时内价格大多是噪音，"高"只用于有重大数据或新闻的时候' },
          reason: { type: 'string', description: '方向判断的依据，一句话，不超过 40 字' },
        },
        required: ['instrument', 'context', 'upside', 'downside', 'watch', 'lean', 'confidence', 'reason'],
      },
    },
  },
  required: ['items'],
};

const OUTLOOK_SYSTEM = `你是国际期货市场分析员，为中文读者写"未来一小时"的情景和方向判断。
规则：
1. 系统已经算好每个品种这一小时的统计波动区间、近几小时涨跌、统计模型的上涨概率和窗口内的数据发布，直接引用，不要自己编数字。
2. 上行情景和下行情景都要写，说清"如果发生什么，可能怎样"。
3. 方向判断（lean）：结合新闻、数据发布和近几小时走势，给出偏涨、偏跌或中性。1 小时内的价格变动大部分是噪音，没有明确依据就选"中性"，不要为了表态而表态；也不要照抄统计模型的结果，它只是参考。你的每一次判断都会被公开核对命中率。
4. 不给交易建议：不要出现买入、卖出、做多、做空、开仓、平仓、加仓、减仓、止损、止盈、目标价等词语，也不要给出具体的预测价格。
5. 用户消息末尾附有你自己近 30 天方向判断的战绩（偏涨/偏跌各多少次、对了多少次）。如果你的命中率不高于 52%，或者明显偏向某一个方向，说明你在没有真实依据时也在表态：这时除非本小时有数据发布或直接相关的新闻，否则一律选"中性"。
6. 每个品种一条，简体中文，简短。`;

// 方向判断用 lean 字段表达；文字里出现交易指令类词语的条目整条丢弃
const BANNED = /(买入|卖出|做多|做空|开仓|建仓|平仓|加仓|减仓|止损|止盈|抄底|逃顶|目标价)/;

export async function generateOutlookCommentary(env, { windowStart, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const ws = windowStart ?? Math.floor(nowSec / HOUR) * HOUR;
  if (nowSec >= ws + HOUR - 300) return { skipped: '窗口已结束' };
  const done = await env.DB.prepare('SELECT 1 AS x FROM hourly_commentary WHERE window_start = ?').bind(ws).first();
  if (done) return { skipped: '已生成' };
  const { results: all } = await env.DB.prepare('SELECT * FROM hourly_outlook WHERE window_start = ?').bind(ws).all();
  if (!all.length) return { skipped: '没有开盘品种' };
  // 有方向判断后每小时都要调用（所有开盘品种合并为一次请求）；"关注原因"只作为提示词里的背景
  const pick = await commentaryTargets(env, all, { ws, nowSec });
  const results = all;
  const lines = [];
  for (const r of results) {
    const inst = byKey[r.instrument];
    const ex = parse(r.events, {});
    const { rows } = await loadHourly(env, r.instrument, nowSec - 2 * DAY);
    const c = hourlyCandles(rows, 30);
    const ago = (n) => (c.length > n ? round((c.at(-1).c / c.at(-1 - n).c - 1) * 100, 2) : null);
    const news = await relatedEvents(env, r.instrument, { days: 2, limit: 2, nowSec }).catch(() => []);
    lines.push(`- ${r.instrument}（${inst.name}${pick.reasons[r.instrument] ? `，关注原因：${pick.reasons[r.instrument].join('、')}` : ''}）：最新 ${r.base_price}（数据延迟约 ${ex.stale_min ?? '?'} 分钟）；近 1 小时 ${ago(1) ?? '—'}%，近 6 小时 ${ago(6) ?? '—'}%，近 24 小时 ${ago(24) ?? '—'}%；`
      + `本小时 68% 统计区间 ${r.lo68}–${r.hi68}（±${ex.w68}%）；波动状态系数 ${r.regime}；`
      + `统计模型上涨概率 ${r.p_up !== null && r.p_up !== undefined ? Math.round(r.p_up * 100) + '%' : '暂无'}；`
      + `数据发布：${(ex.list || []).map((e) => e.title).join('、') || '无'}；相关新闻：${news.map((n) => `${n.title}（${n.direction}）`).join('；') || '无'}`);
  }
  const user = `窗口：${new Date(ws * 1000).toISOString()} 起 1 小时（UTC）。\n${lines.join('\n')}\n\n${await aiRecordText(env, nowSec)}\n\n请为以上每个品种各写一条情景。`;
  const r = await generate(env, { chain: chainFor(env, 'outlook'), purpose: 'outlook', maxTokens: 2500, toolName: 'hourly_outlook', schema: OUTLOOK_SCHEMA, system: OUTLOOK_SYSTEM, user });
  const valid = new Set(results.map((x) => x.instrument));
  const seen = new Set();
  const items = (r.data.items || []).filter((x) => {
    if (!valid.has(x.instrument) || seen.has(x.instrument)) return false;
    if (BANNED.test(`${x.context}${x.upside}${x.downside}${x.watch}${x.reason}`)) return false;
    seen.add(x.instrument);
    return true;
  });
  // AI 方向判断写进展望表，窗口结束后和统计模型一起核对
  for (const x of items) {
    await env.DB.prepare('UPDATE hourly_outlook SET ai_lean = ?, ai_conf = ? WHERE instrument = ? AND window_start = ?').bind(x.lean, x.confidence, x.instrument, ws).run();
  }
  await env.DB.prepare('INSERT OR REPLACE INTO hourly_commentary (window_start, payload, model, created_at) VALUES (?, ?, ?, ?)')
    .bind(ws, JSON.stringify({ items }), r.model, nowSec).run();
  return { window_start: ws, model: r.model, items: items.length, dropped: (r.data.items || []).length - items.length, reasons: pick.reasons };
}
