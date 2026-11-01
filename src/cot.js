// CFTC 持仓报告（Commitments of Traders）。数据为美国政府公开信息，可以展示和转载（注明来源）。
//   商品期货：分类报告（Disaggregated, Futures Only）的“管理基金”（Managed Money，主要是对冲基金/CTA）
//   金融期货：金融期货报告（TFF, Futures Only）的“杠杆基金”（Leveraged Funds）
// 报告统计周二收盘时的持仓，周五美东 15:30 发布。
import { INSTRUMENTS } from './instruments.js';

const DATASETS = {
  disagg: { url: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json', long: ['m_money_positions_long_all', 'm_money_positions_long'], short: ['m_money_positions_short_all', 'm_money_positions_short'], label: '管理基金' },
  tff: { url: 'https://publicreporting.cftc.gov/resource/gpe5-46if.json', long: ['lev_money_positions_long_all', 'lev_money_positions_long'], short: ['lev_money_positions_short_all', 'lev_money_positions_short'], label: '杠杆基金' },
};
export const COT_GROUP_LABEL = { disagg: DATASETS.disagg.label, tff: DATASETS.tff.label };

const pick = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== '') return Number(row[n]);
  return null;
};

/** Socrata 行 → 统一格式；字段名兼容 *_all 与不带后缀两种写法 */
export function parseCotRows(rows, report) {
  const ds = DATASETS[report];
  const byCode = Object.fromEntries(INSTRUMENTS.filter((i) => i.cftc?.report === report).map((i) => [i.cftc.code, i.key]));
  const out = [];
  for (const r of rows) {
    const key = byCode[String(r.cftc_contract_market_code || '').trim()];
    const long = pick(r, ds.long), short = pick(r, ds.short);
    const oi = pick(r, ['open_interest_all', 'open_interest']);
    const date = String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
    if (!key || long === null || short === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ instrument: key, report_date: date, open_interest: oi, long, short });
  }
  return out;
}

/** 拉取并保存。首次（或 weeks 较大时）回填约 3 年，平时只拉最近 6 周 */
export async function updateCot(env, { weeks = null, fetcher = fetch, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const have = (await env.DB.prepare('SELECT COUNT(*) AS n FROM cot').first())?.n || 0;
  const span = weeks ?? (have < 100 ? 160 : 6);
  const since = new Date((nowSec - span * 7 * 86400) * 1000).toISOString().slice(0, 10);
  const report = [];
  for (const [type, ds] of Object.entries(DATASETS)) {
    const codes = INSTRUMENTS.filter((i) => i.cftc?.report === type).map((i) => `'${i.cftc.code}'`).join(',');
    // 用 %20 编码空格（URLSearchParams 会编码成 +，SoQL 查询里不够稳妥）
    const q = Object.entries({
      $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${since}T00:00:00'`,
      $order: 'report_date_as_yyyy_mm_dd DESC',
      $limit: '5000',
    }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    try {
      const res = await fetcher(`${ds.url}?${q}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`CFTC HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const rows = parseCotRows(await res.json(), type);
      const stmt = env.DB.prepare('INSERT OR REPLACE INTO cot (instrument, report_date, open_interest, long, short) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < rows.length; i += 400) {
        await env.DB.batch(rows.slice(i, i + 400).map((r) => stmt.bind(r.instrument, r.report_date, r.open_interest, r.long, r.short)));
      }
      const got = [...new Set(rows.map((r) => r.instrument))];
      const missing = INSTRUMENTS.filter((i) => i.cftc?.report === type && !got.includes(i.key)).map((i) => i.key);
      report.push({ report: type, rows: rows.length, missing });
    } catch (e) {
      report.push({ report: type, error: e.message });
    }
  }
  return report;
}

const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/**
 * 持仓指标（rows 按日期升序）：
 *   net = 多 − 空；net_pct_oi = 净持仓占总持仓 %
 *   cot_index = (当前净持仓 − 近 156 周最低) / (最高 − 最低) × 100，业内常用的“COT 指数”，越接近 100 越拥挤偏多
 */
export function cotMetrics(rows, lookback = 156) {
  if (!rows?.length) return null;
  const win = rows.slice(-lookback);
  const nets = win.map((r) => r.long - r.short);
  const last = win[win.length - 1];
  const net = last.long - last.short;
  const prev = win.length > 1 ? win[win.length - 2].long - win[win.length - 2].short : null;
  const lo = Math.min(...nets), hi = Math.max(...nets);
  const idx = hi > lo ? ((net - lo) / (hi - lo)) * 100 : 50;
  const state = win.length < 26 ? '历史数据不足' : idx >= 90 ? '多头拥挤（接近历史高位）' : idx <= 10 ? '空头拥挤（接近历史低位）' : idx >= 70 ? '偏多' : idx <= 30 ? '偏空' : '中性';
  return {
    report_date: last.report_date,
    long: last.long,
    short: last.short,
    net,
    net_change: prev === null ? null : net - prev,
    net_pct_oi: last.open_interest ? round((net / last.open_interest) * 100) : null,
    cot_index: round(idx, 0),
    weeks: win.length,
    state,
    series: win.map((r) => [r.report_date, r.long - r.short]),
  };
}
