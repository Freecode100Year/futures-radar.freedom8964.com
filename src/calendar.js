// 财经日历：周期性发布的数据（按美东时间规则生成）+ 管理员手动添加的事件（FOMC、WASDE、CPI 等）。
// 周期性事件遇美国联邦假日通常顺延一天，这里不处理节假日，以发布机构官方日历为准。
import { etParts } from './sessions.js';

export const RECURRING = [
  { weekday: 1, time: '16:00', title: 'USDA 作物生长报告（Crop Progress）', instruments: ['soybeans', 'corn', 'wheat'], importance: 2, months: [4, 5, 6, 7, 8, 9, 10, 11] },
  { weekday: 3, time: '10:30', title: 'EIA 原油库存周报（WPSR）', instruments: ['wti', 'brent'], importance: 3 },
  { weekday: 4, time: '08:30', title: 'USDA 出口销售周报', instruments: ['soybeans', 'corn', 'wheat'], importance: 2 },
  { weekday: 4, time: '10:30', title: 'EIA 天然气库存周报', instruments: ['natgas'], importance: 3 },
  { weekday: 5, time: '13:00', title: '贝克休斯钻机数', instruments: ['wti', 'brent', 'natgas'], importance: 1 },
  { weekday: 5, time: '15:30', title: 'CFTC 持仓报告（COT）', instruments: [], importance: 1 },
];

/** 美东当地时间 → UTC 时间戳（毫秒）。先按夏令时（UTC−4）猜，不对再按冬令时（UTC−5） */
export function etToUtc(y, mo, d, h, mi) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, mi);
    const p = etParts(new Date(t));
    if (p.minute === h * 60 + mi) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, mi);
}

/** 生成 [now, now+days] 内的周期性事件 */
export function recurringEvents(nowMs, days = 14) {
  const out = [];
  // 用美东日期逐日推进
  const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  const [y0, m0, d0] = etDate.split('-').map(Number);
  for (let i = 0; i <= days; i++) {
    const dt = new Date(Date.UTC(y0, m0 - 1, d0 + i));
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    for (const r of RECURRING) {
      if (r.weekday !== wd || (r.months && !r.months.includes(mo))) continue;
      const [h, mi] = r.time.split(':').map(Number);
      const ts = etToUtc(y, mo, d, h, mi);
      if (ts < nowMs || ts > nowMs + days * 86400000) continue;
      out.push({ ts: new Date(ts).toISOString(), title: r.title, instruments: r.instruments, importance: r.importance, source: 'recurring' });
    }
  }
  return out;
}

export async function upcomingEvents(env, { nowMs = Date.now(), days = 14 } = {}) {
  const { results } = await env.DB.prepare('SELECT * FROM calendar_events WHERE ts >= ? AND ts <= ? ORDER BY ts')
    .bind(new Date(nowMs - 3600000).toISOString(), new Date(nowMs + days * 86400000).toISOString()).all();
  const custom = results.map((r) => ({ id: r.id, ts: r.ts, title: r.title, instruments: JSON.parse(r.instruments || '[]'), importance: r.importance, note: r.note, source: 'custom' }));
  return [...recurringEvents(nowMs, days), ...custom].sort((a, b) => a.ts.localeCompare(b.ts));
}

/** 管理员添加事件：{ ts: ISO, title, instruments?: [], importance?: 1-3, note? } */
export async function addEvent(env, body) {
  const t = Date.parse(body?.ts);
  if (!Number.isFinite(t) || !body?.title) throw new Error('需要 ts（ISO 时间）和 title');
  const r = await env.DB.prepare('INSERT INTO calendar_events (ts, title, instruments, importance, note) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(new Date(t).toISOString(), String(body.title).slice(0, 120), JSON.stringify(body.instruments || []), Math.min(3, Math.max(1, Number(body.importance) || 2)), body.note ? String(body.note).slice(0, 300) : null).first();
  return { id: r.id };
}
