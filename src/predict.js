// 未来一小时涨跌方向：统计模型给出"上涨概率"，并附一个最简单的对照基准。
//
// 模型：每个品种单独训练的岭回归逻辑回归（强正则化），每小时用近约 70 天的完整小时K线重新拟合。
// 特征全部用"该时段的典型波动"标准化，所以不同品种、不同时段可比：
//   r1   最近 1 小时收益                （短线惯性 / 反转）
//   r3   最近 3 小时累计收益
//   r6   最近 6 小时累计收益
//   r24  最近 24 根小时K线累计收益（不含跨周末的跳空）
//   dev  价格偏离近 20 小时均价的程度    （均值回归）
//   tod  目标时段的历史平均涨跌          （日内季节性）
// 预测目标：下一小时收盘相对本小时收盘是涨还是跌。
//
// 1 小时级别的价格接近随机游走，模型的概率通常落在 45%–55%。这是如实结果，不是 bug；
// 是否有用由公开的命中率和 Brier 分数判断，并与"随机猜"（50%）和"照抄上一小时方向"对比。
import { etParts } from './sessions.js';

const HOUR = 3600;
const FEATURES = ['r1', 'r3', 'r6', 'r24', 'dev', 'tod'];
const LAMBDA = 30; // 正则化强度：样本里的偶然规律不该让概率偏离 50% 太多
const MIN_SAMPLES = 300;

const etHour = (sec) => Math.floor(etParts(new Date(sec * 1000)).minute / 60);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 由完整小时K线（时间戳在整点/半点）构造连续的小时序列与各时段波动 */
function prepare(rows, peers = []) {
  const bars = rows.filter((r) => r.ts % 1800 === 0 && r.close > 0).sort((a, b) => a.ts - b.ts);
  // ret[i] = 第 i 根相对前一根K线。跨过每日休市（CME 17:00–18:00、谷物午盘后）仍算连续；隔了 8 小时以上（周末、节假日）就断开
  const ret = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) if (bars[i].ts - bars[i - 1].ts <= 8 * HOUR) ret[i] = Math.log(bars[i].close / bars[i - 1].close);
  const all = ret.filter((r) => r !== null);
  if (all.length < MIN_SAMPLES) return null;
  const rmsAll = Math.sqrt(all.reduce((a, r) => a + r * r, 0) / all.length) || 1e-6;
  const byH = Array.from({ length: 24 }, () => []);
  ret.forEach((r, i) => r !== null && byH[etHour(bars[i].ts)].push(r));
  const sig = byH.map((xs) => {
    const v = xs.length ? xs.reduce((a, r) => a + r * r, 0) / xs.length : 0;
    return Math.sqrt((xs.length * v + 10 * rmsAll * rmsAll) / (xs.length + 10));
  });
  const drift = byH.map((xs, h) => (xs.length ? (xs.reduce((a, r) => a + r, 0) / xs.length) * (xs.length / (xs.length + 30)) / sig[h] : 0));
  return { bars, ret, sig, drift, peers: peers.map(peerSeries) };
}

/** 相关品种：每根小时K线的标准化收益（按时间戳查），没有数据的时刻当作 0 */
function peerSeries(rows) {
  const bars = (rows || []).filter((r) => r.ts % 1800 === 0 && r.close > 0).sort((a, b) => a.ts - b.ts);
  const ret = new Map();
  for (let i = 1; i < bars.length; i++) if (bars[i].ts - bars[i - 1].ts <= 8 * HOUR) ret.set(bars[i].ts, Math.log(bars[i].close / bars[i - 1].close));
  const xs = [...ret.values()];
  const rms = xs.length ? Math.sqrt(xs.reduce((a, r) => a + r * r, 0) / xs.length) || 1e-6 : 1e-6;
  return { z: (ts) => (ret.has(ts) ? ret.get(ts) / rms : 0) };
}

/**
 * 第 i 根K线收盘时可得的特征，目标时段为 targetH（美东小时）。
 * 跨周末的那一段收益不计入（当作 0），这样周一开盘后不用等满 24 小时才能预测。
 */
function featuresAt(p, i, targetH) {
  if (i < 24) return null;
  const s = p.sig[etHour(p.bars[i].ts)];
  const sum = (n) => {
    const xs = p.ret.slice(i - n + 1, i + 1).filter((r) => r !== null);
    return xs.length ? xs.reduce((a, r) => a + r, 0) / (s * Math.sqrt(xs.length)) : 0;
  };
  const ma = p.bars.slice(i - 19, i + 1).reduce((a, b) => a + b.close, 0) / 20;
  const f = { r1: (p.ret[i] ?? 0) / s, r3: sum(3), r6: sum(6), r24: sum(24), dev: Math.log(p.bars[i].close / ma) / (s * Math.sqrt(10)), tod: p.drift[targetH] * 10 };
  // 相关品种最近 1 / 3 小时的标准化涨跌（联动、领先滞后）
  const t = p.bars[i].ts;
  p.peers.forEach((q, j) => {
    f[`p${j}_1`] = q.z(t);
    f[`p${j}_3`] = (q.z(t) + q.z(t - HOUR) + q.z(t - 2 * HOUR)) / Math.sqrt(3);
  });
  // 截尾，避免个别极端K线主导拟合
  for (const k of Object.keys(f)) f[k] = Math.max(-4, Math.min(4, f[k]));
  return f;
}

/** 岭回归逻辑回归（牛顿法，6 个特征 + 截距，几步就收敛） */
export function fitLogistic(X, y, lambda = LAMBDA) {
  const d = X[0].length + 1;
  let w = new Array(d).fill(0);
  for (let it = 0; it < 25; it++) {
    const g = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let n = 0; n < X.length; n++) {
      const x = [1, ...X[n]];
      const pr = sigmoid(x.reduce((a, v, j) => a + v * w[j], 0));
      const e = pr - y[n], s = pr * (1 - pr);
      for (let j = 0; j < d; j++) {
        g[j] += e * x[j];
        for (let k = 0; k < d; k++) H[j][k] += s * x[j] * x[k];
      }
    }
    for (let j = 1; j < d; j++) { g[j] += lambda * w[j]; H[j][j] += lambda; } // 截距不正则化
    H[0][0] += 1e-6;
    const step = solve(H, g);
    w = w.map((v, j) => v - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return w;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / pv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** 训练：用已收盘的小时K线拟合岭回归逻辑回归。返回 null 表示样本不足 */
export function fitDirectionModel(rows, { lambda = LAMBDA, peers = [] } = {}) {
  const p = prepare(rows, peers);
  if (!p) return null;
  const names = featureNames(peers.length);
  const X = [], y = [];
  for (let i = 24; i < p.bars.length - 1; i++) {
    if (p.ret[i + 1] === null || p.ret[i + 1] === 0) continue;
    const f = featuresAt(p, i, etHour(p.bars[i + 1].ts));
    if (!f) continue;
    X.push(names.map((k) => f[k]));
    y.push(p.ret[i + 1] > 0 ? 1 : 0);
  }
  if (X.length < MIN_SAMPLES) return null;
  return { w: fitLogistic(X, y, lambda), samples: X.length, names, peers: peers.length };
}

const featureNames = (nPeers) => [...FEATURES, ...Array.from({ length: nPeers }, (_, j) => [`p${j}_1`, `p${j}_3`]).flat()];

/** 预测：用训练好的模型，算最新一根K线之后、目标时段的上涨概率 */
export function applyDirectionModel(rows, targetStart, model, { peers = [] } = {}) {
  if (!model) return null;
  const p = prepare(rows, peers.slice(0, model.peers || 0));
  if (!p) return null;
  const { w } = model;
  const names = model.names || FEATURES;
  const last = p.bars.length - 1;
  const f = featuresAt(p, last, etHour(targetStart));
  if (!f) return null;
  const z = w[0] + names.reduce((a, k, j) => a + w[j + 1] * (f[k] ?? 0), 0);
  const lastRet = p.ret[last];
  return {
    p_up: round(sigmoid(z), 4),
    naive_dir: lastRet > 0 ? 1 : lastRet < 0 ? -1 : 0, // 对照基准：照抄最近一小时的方向
    features: Object.fromEntries(names.map((k) => [k, round(f[k], 3)])),
    weights: Object.fromEntries(['bias', ...names].map((k, j) => [k, round(w[j], 4)])),
    samples: model.samples,
  };
}

/**
 * 预测下一小时方向。rows 只能包含预测时刻之前已知的数据。
 * @param {number} targetStart 目标窗口开始时间（unix 秒）
 * @returns {{ p_up, naive_dir, features, weights, samples } | null}
 */
export function predictDirection(rows, targetStart, opts = {}) {
  return applyDirectionModel(rows, targetStart, fitDirectionModel(rows, opts), opts);
}

/** 各品种的相关品种（第 3 步联动特征用；回测确认有用的品种才在线上启用） */
export const PEERS = {
  wti: ['brent', 'es'], brent: ['wti', 'es'], natgas: ['wti'],
  gold: ['silver', 'zn'], silver: ['gold', 'copper'], copper: ['es', 'silver'],
  soybeans: ['corn'], corn: ['soybeans', 'wheat'], wheat: ['corn'],
  es: ['nq', 'zn'], nq: ['es', 'zn'], zn: ['es'],
};

/** 文字描述：只说"概率"，不说买卖 */
export function directionLabel(pUp) {
  if (pUp === null || pUp === undefined) return '—';
  const d = Math.abs(pUp - 0.5);
  if (d < 0.02) return '无明显倾向';
  return `${pUp > 0.5 ? '上涨' : '下跌'}概率 ${Math.round(Math.max(pUp, 1 - pUp) * 100)}%`;
}

/** 方向核对：窗口内涨跌幅小于 0.1 倍预期波动视为"持平"，不计入命中率 */
export function actualDirection(base, actual, sigmaPct) {
  if (!(base > 0) || !(actual > 0)) return null;
  const r = Math.log(actual / base);
  const dead = 0.1 * (sigmaPct / 100);
  return Math.abs(r) < dead ? 0 : r > 0 ? 1 : -1;
}

export const NO_CALL = 0.02; // |P − 50%| 小于 2 个百分点视为"不表态"，不计入命中率

/**
 * 概率校准：模型报 55% 时实际只有 52% 会涨，就照实报 52%。
 * 用该品种最近已核对的（原始概率, 实际涨跌）拟合一个收缩系数 c，使 Brier 分数最小：
 *   校准后 = 50% + c × (原始 − 50%)，c ∈ [0, 1.5]。样本少时 c 向 1（不改动）收缩。
 * hist: [{ p: 原始概率, y: 1 涨 / 0 跌 }]（持平的窗口不放进来）
 */
export const CALIB_WINDOW = 1000;
export function calibrationFactor(hist) {
  const xs = hist.slice(-CALIB_WINDOW).filter((h) => Number.isFinite(h.p) && (h.y === 0 || h.y === 1));
  let num = 0, den = 0;
  for (const h of xs) { num += (h.p - 0.5) * (h.y - 0.5); den += (h.p - 0.5) ** 2; }
  if (xs.length < 50 || den <= 0) return 1;
  const raw = Math.min(1.5, Math.max(0, num / den));
  const w = xs.length / (xs.length + 200);
  return w * raw + (1 - w) * 1;
}
export function calibrateProb(p, hist) {
  if (p === null || p === undefined) return p;
  const c = calibrationFactor(hist);
  return Math.round(Math.min(0.75, Math.max(0.25, 0.5 + c * (p - 0.5))) * 10000) / 10000;
}
