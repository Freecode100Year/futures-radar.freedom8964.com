// 品种视图：行情快照（代码计算）+ 每日 AI 行情解读（模型只做归因）
import { INSTRUMENTS, byKey } from './instruments.js';
import { pickContractSeries } from './market.js';
import { generate, chainFor } from './llm.js';
import { performance, technicals, pivots, seasonality, correlationMatrix, SPREADS, spreadStats, notional } from './analytics.js';
import { cotMetrics, COT_GROUP_LABEL, updateCot } from './cot.js';
import { updateDailyBars, fetchYahooBars } from './contracts.js';
import { sessionStatus, SESSION_LABEL } from './sessions.js';
import { upcomingEvents } from './calendar.js';

const DAY = 86400;
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const parse = (s, d = null) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

// ---------------------------------------------------------------------------
// 1. 行情统计（纯函数）
// ---------------------------------------------------------------------------

/** 小时K线 → 每个 UTC 日的最后一根收盘 */
export function dailyCloses(series) {
  const byDay = new Map();
  for (const p of series) byDay.set(new Date(p.ts * 1000).toISOString().slice(0, 10), p);
  return [...byDay.entries()].map(([day, p]) => ({ day, ts: p.ts, close: p.close }));
}

const pct = (a, b) => (a && b ? (b / a - 1) * 100 : null);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function computeStats(daily) {
  if (daily.length < 5) return null;
  const c = daily.map((d) => d.close);
  const last = c[c.length - 1];
  const at = (k) => (c.length > k ? c[c.length - 1 - k] : null);
  const rets = [];
  for (let i = Math.max(1, c.length - 20); i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const sd = rets.length > 2 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean(rets)) ** 2, 0) / (rets.length - 1)) : null;
  const win = c.slice(-63); // 约 3 个月交易日
  const hi = Math.max(...win), lo = Math.min(...win);
  const ma20 = c.length >= 20 ? mean(c.slice(-20)) : null;
  const ma60 = c.length >= 60 ? mean(c.slice(-60)) : null;
  let trend = '数据不足';
  if (ma20 && ma60) trend = last > ma20 && ma20 > ma60 ? '价格在20日、60日均线之上，均线多头排列' : last < ma20 && ma20 < ma60 ? '价格在20日、60日均线之下，均线空头排列' : '价格与均线交织';
  else if (ma20) trend = last > ma20 ? '价格在20日均线之上' : '价格在20日均线之下';
  return {
    last: round(last, 4),
    last_day: daily[daily.length - 1].day,
    chg_1d_pct: round(pct(at(1), last)),
    chg_5d_pct: round(pct(at(5), last)),
    chg_20d_pct: round(pct(at(20), last)),
    vol_20d_ann_pct: sd === null ? null : round(sd * Math.sqrt(252) * 100, 1),
    range_3m: { high: round(hi, 4), low: round(lo, 4), position_pct: round(hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50, 0) },
    ma20: round(ma20, 4),
    ma60: round(ma60, 4),
    trend,
  };
}

// ---------------------------------------------------------------------------
// 2. 快照（每小时由 cron 计算，前端只读 12 行）
// ---------------------------------------------------------------------------

export async function computeSnapshots(env, nowSec = Math.floor(Date.now() / 1000)) {
  const since = nowSec - 120 * DAY;
  const { results: prices } = await env.DB.prepare('SELECT instrument, contract, ts, close FROM prices WHERE ts >= ? ORDER BY ts').bind(since).all();
  const byInst = {};
  for (const p of prices) (byInst[p.instrument] ||= []).push(p);
  const { results: curveRows } = await env.DB.prepare(
    'SELECT c.instrument, c.payload FROM curves c JOIN (SELECT instrument, MAX(day) AS d FROM curves GROUP BY instrument) m ON c.instrument = m.instrument AND c.day = m.d',
  ).all();
  const curves = Object.fromEntries(curveRows.map((r) => [r.instrument, parse(r.payload)]));
  // 日线（连续合约，最多约 11 年）与 CFTC 持仓
  const dailySince = new Date((nowSec - 11 * 366 * DAY) * 1000).toISOString().slice(0, 10);
  // 这两张表来自 0006 迁移；表不存在或查询失败时照样刷新快照（只是缺少这部分指标），不让整个快照中断
  const dailyBy = {};
  const cotBy = {};
  try {
    const { results: dRows } = await env.DB.prepare('SELECT instrument, day, open, high, low, close, volume FROM daily_bars WHERE day >= ? ORDER BY day').bind(dailySince).all();
    for (const r of dRows) (dailyBy[r.instrument] ||= []).push(r);
  } catch (e) {
    console.error('daily_bars', e.message);
  }
  try {
    const { results: cRows } = await env.DB.prepare('SELECT instrument, report_date, open_interest, long, short FROM cot ORDER BY report_date').all();
    for (const r of cRows) (cotBy[r.instrument] ||= []).push(r);
  } catch (e) {
    console.error('cot', e.message);
  }

  const out = [];
  const ts = new Date(nowSec * 1000).toISOString();
  for (const inst of INSTRUMENTS) {
    const rows = byInst[inst.key] || [];
    const { contract, series } = pickContractSeries(rows, nowSec - 72 * 3600); // 最近 30 天K线最多的合约 ≈ 当前主力
    const hourlyDaily = dailyCloses(series);
    let daily = hourlyDaily.slice(-90);
    let bars = dailyBy[inst.key] || [];
    let barsSource = 'daily';
    // 日线还没回填时，用小时线汇总出的日收盘临时顶上（最多约 4 个月，高低价用收盘价近似）
    if (bars.length < 30 && hourlyDaily.length >= 5) {
      bars = hourlyDaily.map((d) => ({ day: d.day, open: d.close, high: d.close, low: d.close, close: d.close, volume: 0 }));
      barsSource = 'hourly';
    }
    // 小时线不足时（例如刚部署）用连续合约日线画图
    if (daily.length < 20 && barsSource === 'daily' && bars.length >= 20) daily = bars.slice(-90).map((b) => ({ day: b.day, ts: Date.parse(b.day) / 1000 + 20 * 3600, close: b.close }));
    const cot = cotMetrics(cotBy[inst.key]);
    const snap = {
      contract,
      stats: computeStats(daily),
      daily: daily.map((d) => [d.ts, round(d.close, 4)]),
      curve: curves[inst.key] || null,
      perf: performance(bars),
      tech: technicals(bars),
      pivots: pivots(bars[bars.length - 1]),
      seasonality: barsSource === 'daily' ? seasonality(bars) : null,
      bars_source: barsSource, // 'daily' = 10 年日线；'hourly' = 日线回填前的临时数据
      cot: cot ? { ...cot, group: COT_GROUP_LABEL[inst.cftc.report] } : null,
    };
    await env.DB.prepare('INSERT OR REPLACE INTO instrument_snapshot (instrument, updated_at, payload) VALUES (?, ?, ?)')
      .bind(inst.key, ts, JSON.stringify(snap)).run();
    out.push({ instrument: inst.key, contract, days: daily.length, daily_bars: bars.length, cot_weeks: cot?.weeks || 0 });
  }

  // 跨品种：60 日相关性矩阵、价差/比价
  const overview = {
    correlation: correlationMatrix(dailyBy, INSTRUMENTS.map((i) => i.key), 60),
    spreads: SPREADS.map((d) => spreadStats(dailyBy, d)).filter(Boolean),
    history_ready: INSTRUMENTS.filter((i) => (dailyBy[i.key] || []).length >= 500).length,
  };
  await env.DB.prepare('INSERT OR REPLACE INTO overview_snapshot (id, updated_at, payload) VALUES (1, ?, ?)').bind(ts, JSON.stringify(overview)).run();
  return out;
}

// ---------------------------------------------------------------------------
// 3. 关联事件与该品种的预测命中情况
// ---------------------------------------------------------------------------

export async function relatedEvents(env, key, { days = 7, limit = 12, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const cutoff = new Date((nowSec - days * DAY) * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT e.id, COALESCE(e.title_zh, e.title) AS title, e.severity, e.level, e.last_updated_at, a.payload
     FROM events e JOIN analyses a ON a.id = (SELECT id FROM analyses WHERE event_id = e.id ORDER BY created_at DESC LIMIT 1)
     WHERE e.status = 'analyzed' AND e.last_updated_at >= ? ORDER BY e.severity DESC LIMIT 100`,
  ).bind(cutoff).all();
  const out = [];
  for (const r of results) {
    const asset = (parse(r.payload, {}).impact?.assets || []).find((x) => x.instrument === key);
    if (!asset) continue;
    out.push({ id: r.id, title: r.title, severity: r.severity, level: r.level, updated: r.last_updated_at, direction: asset.direction, horizon: asset.horizon, rationale: asset.rationale });
    if (out.length >= limit) break;
  }
  return out;
}

export async function instrumentHitRate(env, key) {
  const { results } = await env.DB.prepare('SELECT market FROM events WHERE market IS NOT NULL ORDER BY last_updated_at DESC LIMIT 500').all();
  let hit = 0, miss = 0, insignificant = 0;
  for (const r of results) {
    const row = (parse(r.market, {}).instruments || []).find((i) => i.key === key);
    if (row?.verdict === 'hit') hit++;
    else if (row?.verdict === 'miss') miss++;
    else if (row?.verdict === 'insignificant') insignificant++;
  }
  return { hit, miss, insignificant, hit_rate: hit + miss ? round(hit / (hit + miss), 3) : null };
}

// ---------------------------------------------------------------------------
// 4. 每日 AI 行情解读
// ---------------------------------------------------------------------------

const EFFECT = ['利多', '利空', '中性'];
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '一句话标题，不超过 30 字' },
    summary: { type: 'string', description: '200 字以内：近期走势如何、主要原因是什么' },
    price_action: { type: 'string', enum: ['上行', '下行', '震荡', '剧烈波动'], description: '过去约 20 个交易日的走势（描述过去，不是预测）' },
    drivers: {
      type: 'array',
      description: '影响价格的因素，按重要性排序，3–6 条',
      items: {
        type: 'object',
        properties: {
          factor: { type: 'string' },
          effect: { type: 'string', enum: EFFECT },
          strength: { type: 'string', enum: ['强', '中', '弱'] },
          basis: { type: 'string', enum: ['事件', '期限结构', '价格行为', '宏观/季节性'], description: '依据来源' },
          event_ids: { type: 'array', items: { type: 'integer' }, description: '依据的事件编号（basis 为“事件”时必填）' },
          note: { type: 'string' },
        },
        required: ['factor', 'effect', 'strength', 'basis'],
      },
    },
    term_structure: { type: 'string', description: '解读升贴水、展期收益反映的供需或持有成本含义' },
    risks: { type: 'array', items: { type: 'string' }, description: '2–4 个可能让价格大幅波动的风险，涵盖上下两个方向' },
    watch: {
      type: 'array',
      description: '接下来值得关注的数据、会议或指标',
      items: { type: 'object', properties: { item: { type: 'string' }, why: { type: 'string' } }, required: ['item', 'why'] },
    },
  },
  required: ['headline', 'summary', 'price_action', 'drivers', 'term_structure', 'risks', 'watch'],
};

const BRIEF_SYSTEM = `你是国际期货市场分析师，为中文读者写每日品种解读。
原则：
1. 行情数字（涨跌幅、波动率、均线、区间、升贴水、展期收益）已由系统计算并给出，直接引用，不要自己编数字。
2. 归因只依据给出的事件列表、期限结构和价格数据，以及公认的宏观/季节性常识；引用事件时在 event_ids 填写编号，不要编造事件。
3. 这是市场分析，不是交易建议：不要给出买卖方向、目标价、止损或仓位建议，也不要预测具体价格。
4. 一律用简体中文。`;

function briefPrompt(inst, snap, events, hits) {
  const s = snap.stats;
  const cm = snap.curve?.metrics;
  const curvePts = (snap.curve?.points || []).map((p) => `${p.contract}(${p.month}) ${p.close}`).join('，');
  const evs = events.length
    ? events.map((e) => `[E${e.id}] ${e.title}｜严重性 ${e.severity}（${e.level}）｜对本品种：${e.direction}，${e.horizon}｜${e.rationale}`).join('\n')
    : '（过去 7 天没有与本品种相关的已分析事件）';
  return `品种：${inst.name}（${inst.root}，${inst.exchange}，单位 ${inst.unit}），当前跟踪合约 ${snap.contract || '未知'}
行情（截至 ${s.last_day}）：最新 ${s.last}；1日 ${s.chg_1d_pct}%，5日 ${s.chg_5d_pct}%，20日 ${s.chg_20d_pct}%；20日年化波动率 ${s.vol_20d_ann_pct}%；
近3个月区间 ${s.range_3m.low}–${s.range_3m.high}，当前处于区间 ${s.range_3m.position_pct}% 位置；20日均线 ${s.ma20}，60日均线 ${s.ma60}；${s.trend}。
期限结构：${cm ? `${cm.structure}，近月 ${cm.front} 对次月 ${cm.next} 价差 ${cm.spread_pct}%，多头展期年化 ${cm.roll_yield_ann_pct}%，曲线斜率年化 ${cm.curve_slope_ann_pct}%。各合约：${curvePts}` : '暂无数据'}
历史上模型对本品种方向判断：命中 ${hits.hit}，相反 ${hits.miss}，不显著 ${hits.insignificant}。
相关事件（事件编号用于 event_ids）：
${evs}

请输出今日行情解读。`;
}

export async function generateBrief(env, key, nowSec = Math.floor(Date.now() / 1000)) {
  const inst = byKey[key];
  if (!inst) throw new Error(`未知品种 ${key}`);
  const row = await env.DB.prepare('SELECT payload FROM instrument_snapshot WHERE instrument = ?').bind(key).first();
  const snap = parse(row?.payload);
  if (!snap?.stats) return { skipped: '行情数据不足' };
  const [events, hits] = await Promise.all([relatedEvents(env, key, { nowSec }), instrumentHitRate(env, key)]);

  const r = await generate(env, {
    chain: chainFor(env, 'brief'),
    purpose: 'brief',
    maxTokens: 2500,
    toolName: 'market_brief',
    schema: BRIEF_SCHEMA,
    system: BRIEF_SYSTEM,
    user: briefPrompt(inst, snap, events, hits),
  });

  const valid = new Set(events.map((e) => e.id));
  const payload = {
    ...r.data,
    drivers: r.data.drivers.map((d) => ({ ...d, event_ids: (d.event_ids || []).filter((id) => valid.has(id)) })),
    events: events.map(({ id, title, severity, level, direction }) => ({ id, title, severity, level, direction })),
  };
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  await env.DB.prepare('INSERT OR REPLACE INTO market_briefs (instrument, day, created_at, model, payload) VALUES (?, ?, ?, ?, ?)')
    .bind(key, day, new Date(nowSec * 1000).toISOString(), r.model, JSON.stringify(payload)).run();
  return { instrument: key, model: r.model, drivers: payload.drivers.length };
}

// ---------------------------------------------------------------------------
// 5. API 数据
// ---------------------------------------------------------------------------

async function latestBriefs(env) {
  const { results } = await env.DB.prepare(
    'SELECT b.* FROM market_briefs b JOIN (SELECT instrument, MAX(day) AS d FROM market_briefs GROUP BY instrument) m ON b.instrument = m.instrument AND b.day = m.d',
  ).all();
  return Object.fromEntries(results.map((b) => [b.instrument, { ...b, payload: parse(b.payload, {}) }]));
}

export async function listInstruments(env) {
  const { results } = await env.DB.prepare('SELECT instrument, updated_at, payload FROM instrument_snapshot').all();
  const snaps = Object.fromEntries(results.map((r) => [r.instrument, { ...parse(r.payload, {}), updated_at: r.updated_at }]));
  const briefs = await latestBriefs(env);
  return INSTRUMENTS.map((i) => {
    const s = snaps[i.key] || {};
    const b = briefs[i.key];
    return {
      key: i.key, name: i.name, sector: i.sector, unit: i.unit, root: i.root,
      contract: s.contract || null, stats: s.stats || null, spark: (s.daily || []).slice(-30).map((d) => d[1]),
      structure: s.curve?.metrics?.structure || null, roll_yield_ann_pct: s.curve?.metrics?.roll_yield_ann_pct ?? null,
      perf: s.perf ? { d1: s.perf.d1, w1: s.perf.w1, m1: s.perf.m1, m3: s.perf.m3, ytd: s.perf.ytd, y1: s.perf.y1, pos52: s.perf.pos52 } : null,
      rsi14: s.tech?.rsi14 ?? null,
      bars_source: s.bars_source || null,
      cot: s.cot ? { net: s.cot.net, net_change: s.cot.net_change, net_pct_oi: s.cot.net_pct_oi, cot_index: s.cot.cot_index, state: s.cot.state, report_date: s.cot.report_date, group: s.cot.group } : null,
      brief: b ? { day: b.day, headline: b.payload.headline, price_action: b.payload.price_action } : null,
      updated_at: s.updated_at || null,
    };
  });
}

export async function getInstrument(env, key) {
  const inst = byKey[key];
  if (!inst) return null;
  const row = await env.DB.prepare('SELECT updated_at, payload FROM instrument_snapshot WHERE instrument = ?').bind(key).first();
  const b = await env.DB.prepare('SELECT * FROM market_briefs WHERE instrument = ? ORDER BY day DESC LIMIT 1').bind(key).first();
  const [events, hits] = await Promise.all([relatedEvents(env, key, { days: 14, limit: 20 }), instrumentHitRate(env, key)]);
  return {
    instrument: { key, name: inst.name, sector: inst.sector, unit: inst.unit, root: inst.root, exchange: inst.exchange, months: inst.months, spec: inst.spec, session_hours: SESSION_LABEL[inst.spec.session], cftc_code: inst.cftc.code },
    session: sessionStatus(inst.spec.session),
    snapshot: row ? { ...parse(row.payload, {}), updated_at: row.updated_at } : null,
    brief: b ? { day: b.day, created_at: b.created_at, model: b.model, ...parse(b.payload, {}) } : null,
    events,
    hit_rate: hits,
  };
}

/** 总览页：交易时段、品种表（多周期涨跌/持仓）、价差、相关性、日历、重点事件 */
export async function getOverview(env, nowMs = Date.now()) {
  const [instruments, ov, calendar, top] = await Promise.all([
    listInstruments(env),
    env.DB.prepare('SELECT updated_at, payload FROM overview_snapshot WHERE id = 1').first(),
    upcomingEvents(env, { nowMs, days: 7 }),
    env.DB.prepare(
      `SELECT id, COALESCE(title_zh, title) AS title, severity, level, sectors, last_updated_at FROM events
       WHERE status = 'analyzed' AND last_updated_at >= ? ORDER BY severity DESC LIMIT 4`,
    ).bind(new Date(nowMs - 3 * 86400000).toISOString()).all(),
  ]);
  const now = new Date(nowMs);
  return {
    sessions: [
      { label: '能源 · 金属 · 股指 · 国债', ...sessionStatus('globex', now) },
      { label: '谷物（大豆 · 玉米 · 小麦）', ...sessionStatus('grains', now) },
    ],
    instruments: instruments.map((i) => ({ ...i, notional: notional(i.stats?.last, byKey[i.key].spec) })),
    ...(parse(ov?.payload, {}) || {}),
    overview_updated_at: ov?.updated_at || null,
    calendar,
    top_events: top.results.map((e) => ({ ...e, sectors: parse(e.sectors, []) })),
  };
}

// ---------------------------------------------------------------------------
// 自动补齐历史数据（每小时由 cron 调用）：部署后不需要手动执行回填命令
// ---------------------------------------------------------------------------

/**
 * 日线不足 500 根的品种每次补 3 个（12 个品种约 1 小时补完）；
 * CFTC 持仓没有数据或最新报告超过 11 天时重新拉取（正常发布周期下最多 10 天）。
 */
export async function ensureHistory(env, { nowSec = Math.floor(Date.now() / 1000), perRun = 3, fetcher = fetchYahooBars, cotFetcher = fetch } = {}) {
  const out = { daily: [], cot: null };
  const { results } = await env.DB.prepare('SELECT instrument, COUNT(*) AS n FROM daily_bars GROUP BY instrument').all();
  const have = Object.fromEntries(results.map((r) => [r.instrument, r.n]));
  const missing = INSTRUMENTS.filter((i) => (have[i.key] || 0) < 500).map((i) => i.key);
  if (missing.length) out.daily = await updateDailyBars(env, { keys: missing.slice(0, perRun), fetcher });

  const last = (await env.DB.prepare('SELECT MAX(report_date) AS d FROM cot').first())?.d;
  if (!last || Date.parse(last) < (nowSec - 11 * DAY) * 1000) out.cot = await updateCot(env, { fetcher: cotFetcher, nowSec });
  return out;
}

/** 数据状态（公开接口，用于排查哪一步没有数据） */
export async function dataStatus(env) {
  const q = async (sql) => {
    try {
      return (await env.DB.prepare(sql).all()).results;
    } catch (e) {
      return { error: e.message };
    }
  };
  const [prices, daily, cot, snaps, state, ov] = await Promise.all([
    q('SELECT instrument, COUNT(*) AS bars, MAX(ts) AS last_ts FROM prices GROUP BY instrument'),
    q('SELECT instrument, COUNT(*) AS bars, MIN(day) AS first_day, MAX(day) AS last_day FROM daily_bars GROUP BY instrument'),
    q('SELECT instrument, COUNT(*) AS weeks, MAX(report_date) AS last_report FROM cot GROUP BY instrument'),
    q('SELECT instrument, updated_at FROM instrument_snapshot'),
    q('SELECT instrument, active_contract, rolled_at FROM instrument_state'),
    q('SELECT updated_at FROM overview_snapshot WHERE id = 1'),
  ]);
  const by = (rows) => (Array.isArray(rows) ? Object.fromEntries(rows.map((r) => [r.instrument, r])) : {});
  const P = by(prices), Dl = by(daily), C = by(cot), S = by(snaps), St = by(state);
  const tableErrors = Object.fromEntries(
    Object.entries({ prices, daily_bars: daily, cot, instrument_snapshot: snaps, instrument_state: state, overview_snapshot: ov })
      .filter(([, v]) => v && !Array.isArray(v)).map(([k, v]) => [k, v.error]),
  );
  return {
    now: new Date().toISOString(),
    table_errors: tableErrors,
    overview_updated_at: Array.isArray(ov) ? ov[0]?.updated_at || null : null,
    instruments: INSTRUMENTS.map((i) => ({
      key: i.key,
      active_contract: St[i.key]?.active_contract || null,
      hourly_bars: P[i.key]?.bars || 0,
      hourly_last: P[i.key]?.last_ts ? new Date(P[i.key].last_ts * 1000).toISOString() : null,
      daily_bars: Dl[i.key]?.bars || 0,
      daily_range: Dl[i.key] ? `${Dl[i.key].first_day} ~ ${Dl[i.key].last_day}` : null,
      cot_weeks: C[i.key]?.weeks || 0,
      cot_last_report: C[i.key]?.last_report || null,
      cftc_code: i.cftc.code,
      snapshot_updated_at: S[i.key]?.updated_at || null,
    })),
  };
}
