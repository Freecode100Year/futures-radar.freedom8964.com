// 交易时段（美东时间，自动处理夏令时）。不含交易所节假日，节假日以 CME 官方日历为准。
//   globex：CME Globex 能源/金属/股指/利率：周日 18:00 至周五 17:00，每天 17:00–18:00 休市一小时
//   grains：CBOT 谷物：周日至周四 20:00 至次日 08:45（夜盘），周一至周五 09:30–14:20（日盘）

export const SESSION_LABEL = {
  globex: 'CME Globex：周日 18:00 – 周五 17:00（美东），每日 17:00–18:00 休市',
  grains: 'CBOT 谷物：夜盘 20:00 – 次日 08:45，日盘 09:30 – 14:20（美东，周日晚至周五）',
};

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 美东时间的星期（0=周日）和当天分钟数 */
export function etParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: DAYS[p.weekday], minute: Number(p.hour) * 60 + Number(p.minute) };
}

export function isOpen(type, date) {
  const { day, minute: m } = etParts(date);
  if (type === 'grains') {
    return (day <= 4 && m >= 20 * 60) || (day >= 1 && day <= 5 && m < 8 * 60 + 45) || (day >= 1 && day <= 5 && m >= 9 * 60 + 30 && m < 14 * 60 + 20);
  }
  return (day === 0 && m >= 18 * 60) || (day >= 1 && day <= 4 && (m < 17 * 60 || m >= 18 * 60)) || (day === 5 && m < 17 * 60);
}

/** 当前状态与下一次开/收盘时间（按 5 分钟步长向后找，最多 4 天） */
export function sessionStatus(type, now = new Date()) {
  const open = isOpen(type, now);
  const t0 = Math.ceil(now.getTime() / 300000) * 300000;
  for (let t = t0; t < now.getTime() + 4 * 86400000; t += 300000) {
    if (isOpen(type, new Date(t)) !== open) return { type, open, next_change: new Date(t).toISOString() };
  }
  return { type, open, next_change: null };
}
