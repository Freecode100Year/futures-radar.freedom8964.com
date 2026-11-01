// 行情分析（纯函数）：多周期涨跌、技术指标、枢轴点、季节性、相关性、价差/比价。
// 输入日线 bars：按日期升序的 [{ day: 'YYYY-MM-DD', open, high, low, close, volume }]
// 输出只描述状态（如“超买区域”“均线上方”），不给买卖建议。

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const pct = (a, b) => (a && b ? (b / a - 1) * 100 : null);

// ---------------------------------------------------------------------------
// 多周期涨跌
// ---------------------------------------------------------------------------

export const PERIODS = [
  ['d1', 1, '1日'], ['w1', 5, '1周'], ['m1', 21, '1月'], ['m3', 63, '3月'], ['m6', 126, '6月'], ['y1', 252, '1年'],
];

export function performance(bars) {
  if (!bars || bars.length < 2) return null;
  const c = bars.map((b) => b.close);
  const last = c[c.length - 1];
  const out = { last: round(last, 4), day: bars[bars.length - 1].day };
  for (const [k, n] of PERIODS) out[k] = c.length > n ? round(pct(c[c.length - 1 - n], last)) : null;
  const year = out.day.slice(0, 4);
  const prevYear = [...bars].reverse().find((b) => b.day.slice(0, 4) < year);
  out.ytd = prevYear ? round(pct(prevYear.close, last)) : null;
  const w = bars.slice(-252);
  const hi = Math.max(...w.map((b) => b.high)), lo = Math.min(...w.map((b) => b.low));
  out.hi52 = round(hi, 4);
  out.lo52 = round(lo, 4);
  out.pos52 = hi > lo ? round(((last - lo) / (hi - lo)) * 100, 0) : null;
  out.from_hi52 = round(pct(hi, last));
  return out;
}

// ---------------------------------------------------------------------------
// 技术指标
// ---------------------------------------------------------------------------

function ema(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = mean(values.slice(0, n));
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) out.push(null);
    else if (i === n - 1) out.push(prev);
    else out.push((prev = values[i] * k + prev * (1 - k)));
  }
  return out;
}

/** Wilder RSI */
export function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder ATR */
export function atr(bars, n = 14) {
  if (bars.length <= n) return null;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  let a = mean(tr.slice(0, n));
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

export function technicals(bars) {
  if (!bars || bars.length < 35) return null;
  const c = bars.map((b) => b.close);
  const last = c[c.length - 1];
  const r = rsi(c, 14);

  const e12 = ema(c, 12), e26 = ema(c, 26);
  const macdLine = c.map((_, i) => (e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null)).filter((x) => x !== null);
  const sig = ema(macdLine, 9);
  const macd = macdLine[macdLine.length - 1], signal = sig[sig.length - 1];

  const a = atr(bars, 14);
  const w20 = c.slice(-20), m20 = mean(w20), s20 = sd(w20);
  const upper = m20 + 2 * s20, lower = m20 - 2 * s20;
  const sma50 = c.length >= 50 ? mean(c.slice(-50)) : null;
  const sma200 = c.length >= 200 ? mean(c.slice(-200)) : null;
  const rets = c.slice(-21).slice(1).map((x, i) => Math.log(x / c.slice(-21)[i]));
  const hv20 = sd(rets);

  const states = [];
  if (r !== null) states.push(r >= 70 ? 'RSI 处于超买区域（≥70）' : r <= 30 ? 'RSI 处于超卖区域（≤30）' : 'RSI 处于中性区域');
  if (macd !== null && signal !== null) states.push(macd > signal ? 'MACD 在信号线上方' : 'MACD 在信号线下方');
  if (sma200) states.push(last > sma200 ? '价格在 200 日均线上方' : '价格在 200 日均线下方');
  if (sma50 && sma200) states.push(sma50 > sma200 ? '50 日均线高于 200 日均线' : '50 日均线低于 200 日均线');
  const pctB = upper > lower ? (last - lower) / (upper - lower) : null;
  if (pctB !== null) states.push(pctB > 1 ? '价格突破布林带上轨' : pctB < 0 ? '价格跌破布林带下轨' : '价格在布林带内');

  return {
    rsi14: round(r, 1),
    macd: round(macd, 4),
    macd_signal: round(signal, 4),
    macd_hist: round(macd - signal, 4),
    atr14: round(a, 4),
    atr_pct: round((a / last) * 100),
    boll_upper: round(upper, 4),
    boll_lower: round(lower, 4),
    boll_pctb: round(pctB, 2),
    boll_width_pct: round(((upper - lower) / m20) * 100),
    sma20: round(m20, 4),
    sma50: round(sma50, 4),
    sma200: round(sma200, 4),
    dist_sma50_pct: round(pct(sma50, last)),
    dist_sma200_pct: round(pct(sma200, last)),
    hv20_ann_pct: round(hv20 * Math.sqrt(252) * 100, 1),
    states,
  };
}

/** 经典枢轴点（用上一交易日高低收），仅作参考价位 */
export function pivots(bar) {
  if (!bar) return null;
  const { high: h, low: l, close: c } = bar;
  const p = (h + l + c) / 3;
  return { day: bar.day, p: round(p, 4), r1: round(2 * p - l, 4), s1: round(2 * p - h, 4), r2: round(p + (h - l), 4), s2: round(p - (h - l), 4), r3: round(h + 2 * (p - l), 4), s3: round(l - 2 * (h - p), 4) };
}

// ---------------------------------------------------------------------------
// 季节性
// ---------------------------------------------------------------------------

/**
 * monthly：每个自然月的历史平均涨跌、中位数、上涨年份占比（只用完整月份）
 * path：一年内按周累计涨跌（%），近 5 年平均、近 10 年平均（不含今年）与今年
 */
export function seasonality(bars) {
  if (!bars || bars.length < 300) return null;
  const monthEnd = new Map(); // 'YYYY-MM' → 当月最后收盘
  for (const b of bars) monthEnd.set(b.day.slice(0, 7), b.close);
  const months = [...monthEnd.keys()].sort();
  const lastMonth = months[months.length - 1]; // 当月未结束，不计入
  const byMonth = Array.from({ length: 12 }, () => []);
  for (let i = 1; i < months.length; i++) {
    if (months[i] === lastMonth) continue;
    byMonth[Number(months[i].slice(5)) - 1].push((monthEnd.get(months[i]) / monthEnd.get(months[i - 1]) - 1) * 100);
  }
  const monthly = byMonth.map((xs, i) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return {
      month: i + 1,
      n: xs.length,
      mean: xs.length ? round(mean(xs)) : null,
      median: xs.length ? round(sorted[sorted.length >> 1]) : null,
      win_rate: xs.length ? round((xs.filter((x) => x > 0).length / xs.length) * 100, 0) : null,
    };
  });

  // 每年按周（0–52）记录相对年初第一个收盘的累计涨跌
  const years = {};
  for (const b of bars) {
    const y = b.day.slice(0, 4);
    const doy = Math.floor((Date.parse(b.day) - Date.parse(`${y}-01-01`)) / 86400000);
    const wk = Math.min(52, Math.floor(doy / 7));
    const Y = (years[y] ||= { base: b.close, weeks: Array(53).fill(null) });
    Y.weeks[wk] = (b.close / Y.base - 1) * 100;
  }
  const curYear = bars[bars.length - 1].day.slice(0, 4);
  const full = Object.keys(years).filter((y) => y < curYear && years[y].weeks[51] !== null).sort();
  const avgPath = (ys) => {
    if (!ys.length) return null;
    return Array.from({ length: 53 }, (_, w) => {
      const v = ys.map((y) => fillForward(years[y].weeks, w)).filter((x) => x !== null);
      return v.length ? round(mean(v)) : null;
    });
  };
  const current = years[curYear] ? years[curYear].weeks.map((v) => (v === null ? null : round(v))) : null;
  return {
    monthly,
    years: full.length,
    path: { avg5: avgPath(full.slice(-5)), avg10: avgPath(full.slice(-10)), current },
    current_month: Number(lastMonth.slice(5)),
  };
}

function fillForward(arr, i) {
  for (let k = i; k >= 0; k--) if (arr[k] !== null) return arr[k];
  return null;
}

// ---------------------------------------------------------------------------
// 跨品种：相关性矩阵、价差/比价
// ---------------------------------------------------------------------------

/** 按日期对齐多个品种的收盘价 */
export function alignCloses(barsByKey, keys) {
  const maps = keys.map((k) => new Map((barsByKey[k] || []).map((b) => [b.day, b.close])));
  const days = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { days, closes: maps.map((m) => days.map((d) => m.get(d))) };
}

/** 近 window 个交易日对数收益率的相关系数矩阵 */
export function correlationMatrix(barsByKey, keys, window = 60) {
  const usable = keys.filter((k) => (barsByKey[k] || []).length > window);
  if (usable.length < 2) return null;
  const { days, closes } = alignCloses(barsByKey, usable);
  if (days.length <= window) return null;
  const rets = closes.map((c) => c.slice(-window - 1).slice(1).map((x, i) => Math.log(x / c.slice(-window - 1)[i])));
  const corr = (a, b) => {
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };
  return { keys: usable, window, end: days[days.length - 1], matrix: rets.map((a) => rets.map((b) => round(corr(a, b)))) };
}

export const SPREADS = [
  { key: 'brent_wti', name: '布伦特 − WTI 价差', unit: '美元/桶', legs: ['brent', 'wti'], f: (a, b) => a - b, digits: 2, note: '反映美国国内与国际原油的相对紧张程度、运输成本' },
  { key: 'gold_silver', name: '金银比', unit: '倍', legs: ['gold', 'silver'], f: (a, b) => a / b, digits: 1, note: '比值走高通常对应避险情绪升温或工业需求走弱' },
  { key: 'copper_gold', name: '铜金比（×1000）', unit: '', legs: ['copper', 'gold'], f: (a, b) => (a / b) * 1000, digits: 3, note: '常被视作经济增长预期的温度计，与美债收益率相关性较高' },
  { key: 'soy_corn', name: '大豆/玉米比价', unit: '倍', legs: ['soybeans', 'corn'], f: (a, b) => a / b, digits: 2, note: '影响美国农民的种植面积选择，比值高时倾向多种大豆' },
];

export function spreadStats(barsByKey, def, days = 252) {
  if (!def.legs.every((k) => (barsByKey[k] || []).length > 20)) return null;
  const { days: ds, closes } = alignCloses(barsByKey, def.legs);
  if (ds.length < 20) return null;
  const vals = ds.map((d, i) => def.f(closes[0][i], closes[1][i]));
  const win = vals.slice(-days);
  const cur = win[win.length - 1];
  const m = mean(win), s = sd(win);
  return {
    key: def.key, name: def.name, unit: def.unit, note: def.note,
    value: round(cur, def.digits),
    mean_1y: round(m, def.digits),
    z_1y: s ? round((cur - m) / s, 2) : null,
    percentile_1y: round((win.filter((v) => v <= cur).length / win.length) * 100, 0),
    chg_1m: vals.length > 21 ? round(cur - vals[vals.length - 22], def.digits) : null,
    series: ds.slice(-days).map((d, i) => [d, round(win[i], def.digits)]),
  };
}

/** 名义价值 = 价格 × 每单位美元价值（谷物报价为美分，pointValue 已按美分计） */
export const notional = (price, spec) => (Number.isFinite(price) && spec ? Math.round(price * spec.pointValue) : null);
