// 生成期货版演示数据：行情/期限结构/统计/校准全部由后端同一套函数计算；AI 文本为手写示例并标注“演示”
import { writeFileSync } from 'node:fs';
import { computeSeverity, levelOf } from '../src/rubric.js';
import { calibrate } from '../src/market.js';
import { candidateContracts, curveMetrics } from '../src/contracts.js';
import { computeStats } from '../src/futures.js';
import { INSTRUMENTS, byKey } from '../src/instruments.js';
import { synthSeries } from '../test/mock-env.js';
import { performance, technicals, pivots, seasonality, correlationMatrix, SPREADS, spreadStats, notional } from '../src/analytics.js';
import { cotMetrics, COT_GROUP_LABEL } from '../src/cot.js';
import { recurringEvents } from '../src/calendar.js';
import { SESSION_LABEL, isOpen } from '../src/sessions.js';
import { hourlyCandles, hourStats, computeOutlook, priceTime } from '../src/outlook.js';

const NOW = Math.floor(Date.now() / 1000);
const H = 3600, D = 86400;
const iso = (s) => new Date(s * 1000).toISOString();

// ---------------- 品种行情（日线 + 小时线），含事件跳变 ----------------
const BASE = { wti: [76, 0.018], brent: [80, 0.017], natgas: [3.2, 0.035], gold: [2650, 0.009], silver: [31, 0.016], copper: [4.4, 0.012],
  soybeans: [1050, 0.011], corn: [430, 0.012], wheat: [560, 0.015], es: [5900, 0.008], nq: [20800, 0.011], zn: [110.5, 0.003] };
// 事件：[锚点距今小时, {品种: 对数跳变}]
const EVENT_JUMPS = [
  [74, { brent: 0.05, wti: 0.048, gold: 0.011, zn: 0.002 }],
  [50, { es: -0.006, nq: -0.004, zn: 0.0005, gold: 0.004 }],
  [30, { soybeans: 0.009, corn: 0.006 }],
];
const hourly = {}, daily = {};
// 第一遍：各品种独立的随机游走（去掉大部分漂移）
const base0 = {};
INSTRUMENTS.forEach((inst, i) => {
  const [base, dvol] = BASE[inst.key];
  const pts = synthSeries({ start: NOW - 100 * D, end: NOW, base, sigma: dvol / Math.sqrt(24), seed: 100 + i });
  const drift = Math.log(pts.at(-1).close / pts[0].close);
  pts.forEach((p, k) => (p.close *= Math.exp(-0.85 * drift * (k / (pts.length - 1)))));
  base0[inst.key] = pts;
});
// 第二遍：按品种间的常见联动混合（对数收益层面），让演示的相关性矩阵像真实市场
const LINKS = { wti: ['brent', 0.97], silver: ['gold', 0.75], copper: ['es', 0.45], corn: ['soybeans', 0.65], wheat: ['corn', 0.55], nq: ['es', 0.88], zn: ['es', -0.4] };
for (const [k, [leader, w]] of Object.entries(LINKS)) {
  const own = base0[k], lead = base0[leader];
  const o0 = Math.log(own[0].close), l0 = Math.log(lead[0].close);
  const vo = BASE[k][1], vl = BASE[leader][1];
  own.forEach((p, i) => {
    const lr = (Math.log(lead[i].close) - l0) * (vo / vl);
    const orr = Math.log(p.close) - o0;
    p.close = Math.exp(o0 + w * lr + Math.sqrt(1 - w * w) * orr);
  });
}
// 第三遍：叠加事件跳变，汇总成日线
for (const inst of INSTRUMENTS) {
  const pts = base0[inst.key];
  for (const [hAgo, jumps] of EVENT_JUMPS) {
    const j = jumps[inst.key];
    if (!j) continue;
    const at = NOW - hAgo * H + 2 * H;
    for (const p of pts) if (p.ts > at) p.close *= Math.exp(j);
  }
  hourly[inst.key] = pts;
  const byDay = new Map();
  for (const p of pts) byDay.set(iso(p.ts).slice(0, 10), p);
  daily[inst.key] = [...byDay.entries()].map(([day, p]) => ({ day, ts: p.ts, close: p.close })).slice(-90);
}

// ---------------- 期限结构 ----------------
const CURVE_SHAPE = { wti: [0, -0.7, -1.3, -1.8, -2.2, -2.5], brent: [0, -0.8, -1.4, -1.9, -2.3, -2.6], natgas: [0, 9, 11, 4, -6, -8],
  gold: [0, 0.7, 1.4, 2.1, 2.8, 3.5], silver: [0, 0.6, 1.2, 1.8, 2.4, 3.0], copper: [0, 0.4, 0.8, 1.1, 1.4, 1.7],
  soybeans: [0, 1.1, 2.0, 2.6, 3.0, 3.1], corn: [0, 1.8, 3.1, 4.0, 4.6, 5.0], wheat: [0, 2.0, 3.6, 4.8, 5.8, 6.6],
  es: [0, 0.9, 1.8, 2.7, 3.6, 4.5], nq: [0, 1.0, 2.0, 3.0, 4.0, 5.0], zn: [0, -0.15, -0.3, -0.45, -0.6, -0.75] };
const curves = {};
for (const inst of INSTRUMENTS) {
  const last = daily[inst.key].at(-1).close;
  const cands = candidateContracts(inst, NOW + 12 * D, 6); // 跳过即将到期的当月合约
  const points = cands.map((c, k) => ({ ...c, close: +(last * (1 + CURVE_SHAPE[inst.key][k] / 100)).toFixed(4), volume: Math.round(200000 / (k + 1)) }));
  curves[inst.key] = { points, metrics: curveMetrics(points), active: points[0].contract };
}

// ---------------- 事件 ----------------
const S = (sid, source, title, hAgo) => ({ sid, article_id: sid, source, title: `[演示] ${title}`, url: `https://example.com/demo/${sid}`, published_at: iso(NOW - hAgo * H) });
const sc = (arr, why) => Object.fromEntries(['military_escalation', 'market_shock', 'supply_demand', 'systemic_contagion', 'geographic_scope', 'persistence', 'escalation_momentum']
  .map((k, i) => [k, { score: arr[i], rationale: why[i], source_ids: [1 + (i % 2)] }]));

const RAW = [
  {
    hAgo: 72, count: 16, hist: [52, 58],
    title_zh: '霍尔木兹海峡油轮遭扣押，原油供应担忧升温',
    summary_zh: '（虚构演示）一艘油轮在霍尔木兹海峡被扣押，多国宣布护航。原油期货大幅升水，近月价差走阔，航运保险费率上调。',
    domains: ['地缘政治', '军事', '能源'],
    scores: sc([3, 3, 3, 4, 3, 3, 3], ['扣押船只并伴随舰艇对峙', '原油与黄金联动上涨', '海峡承担全球约五分之一海运原油（推断）', '能源→通胀→利率预期多渠道传导', '海湾与亚洲进口国', '护航部署或持续数周', '各方表态强硬']),
    confidence: 0.72,
    impact: {
      regions: [{ name: '霍尔木兹海峡', lat: 26.6, lon: 56.3, role: '发源地' }, { name: '沙特阿拉伯', lat: 24.7, lon: 46.7, role: '直接影响' }, { name: '中国', lat: 39.9, lon: 116.4, role: '间接影响', note: '最大原油进口国' }],
      sectors: [{ name: '油轮航运', direction: '上涨', note: '运价走高' }, { name: '炼化', direction: '不确定', note: '原料成本与价差此消彼长' }],
      assets: [
        { asset: '布伦特原油', instrument: 'brent', direction: '上涨', horizon: '数日', rationale: '供应风险溢价' },
        { asset: 'WTI原油', instrument: 'wti', direction: '上涨', horizon: '数日', rationale: '跟随布伦特' },
        { asset: '黄金', instrument: 'gold', direction: '上涨', horizon: '数周', rationale: '避险需求' },
        { asset: '美国10年期国债期货', instrument: 'zn', direction: '上涨', horizon: '数日', rationale: '避险买盘' },
      ],
    },
    transmission_chain: [
      { from: '扣押油轮', to: '海峡通行风险', mechanism: '军事对峙', lag: '即时' },
      { from: '海峡通行风险', to: '原油近月升水', mechanism: '供应风险溢价 + 保险成本', lag: '1-3天' },
      { from: '原油近月升水', to: '通胀预期', mechanism: '能源成本', lag: '1-2月' },
    ],
    timeline: [
      { date: iso(NOW - 74 * H).slice(0, 10), date_precision: '精确', event: '油轮在海峡东口被拦截登船', source_ids: [1], quote: 'naval forces boarded the tanker', status: '已证实', verified: true },
      { date: iso(NOW - 50 * H).slice(0, 10), date_precision: '精确', event: '布伦特期货盘中涨幅超过 5%', source_ids: [2], quote: 'Brent futures jumped more than 5%', status: '已证实', verified: true },
      { date: iso(NOW - 30 * H).slice(0, 10), date_precision: '约略', event: '多国宣布增派护航舰艇', source_ids: [1], quote: 'additional escort vessels', status: '单一信源', verified: false },
    ],
    contradictions: [],
    scenarios: [
      { name: '外交降温', likelihood: '中', triggers: '油轮获释', market_implication: '原油回吐风险溢价，近月价差收窄' },
      { name: '僵持', likelihood: '高', triggers: '护航常态化', market_implication: '贴水结构维持' },
      { name: '冲突升级', likelihood: '低', triggers: '再次扣押或交火', market_implication: '原油跳涨，股指期货承压' },
    ],
    watch_indicators: ['海峡日通行油轮数量', '布伦特近月-次月价差', '战争险保费'],
    sources: [S(1, 'Example Wire', 'Tanker seized in Strait of Hormuz', 74), S(2, 'Example Markets', 'Oil futures jump on Gulf tensions', 50)],
  },
  {
    hAgo: 48, count: 11, hist: [44],
    title_zh: '美联储意外维持利率不变，降息预期降温',
    summary_zh: '（虚构演示）市场原本押注降息，美联储维持利率不变并上调通胀预测。美股指期货下跌，美债期货先跌后涨，黄金小幅走高。',
    domains: ['货币政策', '宏观经济'],
    scores: sc([0, 3, 0, 3, 5, 2, 2], ['无', '股指期货与国债期货明显波动', '不直接影响商品供需', '利率预期影响所有资产定价', '全球', '影响到下次议息会议', '后续取决于数据']),
    confidence: 0.81,
    impact: {
      regions: [{ name: '美国', lat: 38.9, lon: -77.0, role: '发源地' }],
      sectors: [{ name: '科技股', direction: '下跌', note: '估值对利率敏感' }],
      assets: [
        { asset: '标普500期货', instrument: 'es', direction: '下跌', horizon: '数日', rationale: '贴现率上升' },
        { asset: '纳指100期货', instrument: 'nq', direction: '下跌', horizon: '数日', rationale: '成长股更敏感' },
        { asset: '美国10年期国债期货', instrument: 'zn', direction: '下跌', horizon: '数日', rationale: '收益率上行' },
        { asset: '黄金', instrument: 'gold', direction: '不确定', horizon: '数周', rationale: '利率与避险相互抵消' },
      ],
    },
    transmission_chain: [
      { from: '维持利率', to: '降息预期回落', mechanism: '政策信号', lag: '即时' },
      { from: '降息预期回落', to: '美债收益率上行', mechanism: '利率重定价', lag: '即时' },
      { from: '美债收益率上行', to: '股指估值承压', mechanism: '贴现率', lag: '数日' },
    ],
    timeline: [{ date: iso(NOW - 50 * H).slice(0, 10), date_precision: '精确', event: '议息会议宣布维持利率', source_ids: [1], quote: 'held rates steady', status: '已证实', verified: true }],
    contradictions: [],
    scenarios: [{ name: '数据走弱', likelihood: '中', triggers: '就业放缓', market_implication: '降息预期回升，股指期货修复' }],
    watch_indicators: ['联邦基金利率期货隐含概率', '10年期收益率', '核心 PCE'],
    sources: [S(3, 'Example Markets', 'Fed holds rates, signals patience', 50)],
  },
  {
    hAgo: 28, count: 7, hist: [36],
    title_zh: '巴西主产区干旱，大豆产量预期下调',
    summary_zh: '（虚构演示）巴西中西部持续干旱，多家机构下调新季大豆产量预期。芝加哥大豆期货上涨，玉米跟涨。',
    domains: ['农业', '天气'],
    scores: sc([0, 2, 3, 2, 3, 3, 2], ['无', '大豆、玉米期货上涨', '主产国减产预期', '影响饲料与压榨链条', '南美与全球进口国', '持续到收获期', '取决于降雨']),
    confidence: 0.64,
    impact: {
      regions: [{ name: '巴西马托格罗索州', lat: -12.6, lon: -55.7, role: '发源地' }, { name: '中国', lat: 39.9, lon: 116.4, role: '间接影响', note: '最大进口国' }],
      sectors: [{ name: '压榨', direction: '下跌', note: '原料成本上升' }],
      assets: [
        { asset: '大豆', instrument: 'soybeans', direction: '上涨', horizon: '数周', rationale: '供应收紧' },
        { asset: '玉米', instrument: 'corn', direction: '上涨', horizon: '数周', rationale: '替代与种植面积竞争' },
      ],
    },
    transmission_chain: [{ from: '干旱', to: '减产预期', mechanism: '单产下降', lag: '数周' }, { from: '减产预期', to: '美豆出口需求', mechanism: '买家转向美国', lag: '1-2月' }],
    timeline: [{ date: iso(NOW - 28 * H).slice(0, 10), date_precision: '约略', event: '多家机构下调巴西大豆产量预期', source_ids: [1], quote: 'cut its Brazil soybean estimate', status: '单一信源', verified: true }],
    contradictions: [],
    scenarios: [{ name: '降雨恢复', likelihood: '中', triggers: '未来两周降雨', market_implication: '天气溢价回吐' }],
    watch_indicators: ['巴西降雨预报', 'USDA 月度供需报告', '美豆出口销售'],
    sources: [S(4, 'Example Agri', 'Drought trims Brazil soybean outlook', 28)],
  },
];

const events = [], details = {};
RAW.forEach((r, i) => {
  const id = i + 1;
  const severity = computeSeverity(r.scores);
  const { hAgo, count, hist, ...a } = r;
  const firstSeen = iso(NOW - hAgo * H);
  const market = calibrate({ ...a, severity }, firstSeen, hourly, NOW);
  const sectors = [...new Set(a.impact.assets.map((x) => byKey[x.instrument]?.sector).filter(Boolean))];
  const history = [...hist, severity].map((s, j, arr) => ({ created_at: iso(NOW - (arr.length - j) * 6 * H), severity: s, source: 'analysis' }));
  if (Math.abs(market.severity - severity) >= 0.5) history.push({ created_at: iso(NOW - 600), severity: market.severity, source: 'market' });
  const ev = { id, title: r.sources[0].title, title_zh: r.title_zh, severity: market.severity, level: market.level, model_severity: severity, market,
    confidence: r.confidence, domains: r.domains, sectors, article_count: count, first_seen_at: firstSeen, last_updated_at: iso(NOW - (i + 1) * 1500), status: 'analyzed' };
  events.push({ ...ev, market: undefined, title: r.title_zh, summary: r.summary_zh });
  details[id] = {
    event: ev,
    analysis: { ...a, severity, level: levelOf(severity), sectors, quality: { dropped_timeline_items: 0, verified_quote_ratio: 0.8 }, created_at: history.at(-1).created_at, model: 'glm:glm-4.7-flash（演示）' },
    history,
    articles: r.sources.map((s) => ({ id: s.sid, title: s.title, url: s.url, source_name: s.source, published_at: s.published_at })),
  };
});
events.push({ id: 4, title: '美国冬小麦播种进度符合预期', severity: 20, level: '关注', domains: ['农业'], sectors: ['农产品'], article_count: 2,
  first_seen_at: iso(NOW - 12 * H), last_updated_at: iso(NOW - 4 * H), status: 'watch', summary: null });
details[4] = { event: { id: 4, title_zh: '美国冬小麦播种进度符合预期', article_count: 2, triage: { rough_severity: 1 } }, analysis: null, history: [],
  articles: [{ id: 9, title: '[演示] Winter wheat planting on pace', url: 'https://example.com/demo/9', source_name: 'Example Agri', published_at: iso(NOW - 12 * H) }] };
events.sort((a, b) => b.last_updated_at.localeCompare(a.last_updated_at));

// ---------------- 品种解读（手写示例） ----------------
const B = (headline, price_action, summary, drivers, term, risks, watch) => ({ headline, price_action, summary, drivers, term_structure: term, risks, watch });
const BRIEFS = {
  brent: B('海峡紧张推高风险溢价，近月贴水加深', '上行', '（演示）本周布伦特在油轮扣押事件后跳涨，随后维持高位震荡。近月对次月贴水扩大，显示现货端偏紧。', [
    { factor: '霍尔木兹海峡油轮扣押', effect: '利多', strength: '强', basis: '事件', event_ids: [1], note: '供应中断风险抬升风险溢价' },
    { factor: '近月贴水加深', effect: '利多', strength: '中', basis: '期限结构', note: '多头展期收益为正，现货偏紧' },
    { factor: '美联储维持利率', effect: '利空', strength: '弱', basis: '事件', event_ids: [2], note: '需求预期略受压制' },
  ], '贴水结构反映近端供应偏紧，展期对多头有利；若海峡局势缓和，价差可能先收窄。', ['外交降温导致风险溢价快速回吐', '冲突升级引发跳涨'], [{ item: 'EIA 周度库存', why: '验证需求与库存' }, { item: '海峡通行数据', why: '供应风险是否落地' }]),
  gold: B('避险与利率预期拉锯，金价高位小幅上行', '上行', '（演示）地缘风险带来避险买盘，美联储偏鹰限制涨幅。期限结构为正常升水，反映持有成本。', [
    { factor: '中东地缘风险', effect: '利多', strength: '中', basis: '事件', event_ids: [1] },
    { factor: '降息预期降温', effect: '利空', strength: '中', basis: '事件', event_ids: [2], note: '实际利率上行抬高持有黄金的机会成本' },
    { factor: '价格处于 3 个月区间上沿', effect: '中性', strength: '弱', basis: '价格行为' },
  ], '升水幅度与利率大致一致，没有显示出现货紧张。', ['美元走强', '地缘局势迅速缓和'], [{ item: '美国 CPI', why: '影响降息预期' }]),
  soybeans: B('巴西干旱带来天气溢价，美豆走强', '上行', '（演示）巴西主产区干旱推动产量下调预期，美豆期货上涨，远月升水缩小。', [
    { factor: '巴西干旱', effect: '利多', strength: '强', basis: '事件', event_ids: [3] },
    { factor: '南美收获前天气季节性', effect: '利多', strength: '弱', basis: '宏观/季节性', note: '这一时段天气溢价通常较高' },
  ], '温和升水，远月升水收窄，说明市场更担心近端供应。', ['降雨恢复导致溢价回吐', '中国采购放缓'], [{ item: 'USDA 月度供需报告', why: '官方产量估计' }]),
  es: B('利率预期上修，股指期货回调', '震荡', '（演示）美联储维持利率不变后，标普期货回调，随后在 20 日均线附近震荡。', [
    { factor: '降息预期降温', effect: '利空', strength: '中', basis: '事件', event_ids: [2] },
    { factor: '油价上涨推高通胀担忧', effect: '利空', strength: '弱', basis: '事件', event_ids: [1] },
  ], '升水与利率减去股息率的持有成本一致。', ['财报季超预期', '收益率继续上行'], [{ item: '核心 PCE', why: '通胀路径' }]),
  zn: B('避险与鹰派信号相互抵消，美债期货窄幅波动', '震荡', '（演示）地缘风险带来避险买盘，但美联储偏鹰压制价格，整体窄幅波动。', [
    { factor: '美联储维持利率', effect: '利空', strength: '中', basis: '事件', event_ids: [2] },
    { factor: '中东避险需求', effect: '利多', strength: '弱', basis: '事件', event_ids: [1] },
  ], '轻微贴水，与正收益率曲线下的持有收益一致。', ['通胀数据超预期', '避险需求骤增'], [{ item: '10 年期国债拍卖', why: '需求强弱' }]),
  natgas: B('冬季前季节性升水明显', '剧烈波动', '（演示）天然气波动加大，冬季合约相对近月明显升水。', [
    { factor: '冬季取暖需求季节性', effect: '利多', strength: '中', basis: '宏观/季节性' },
    { factor: '库存高于五年均值', effect: '利空', strength: '中', basis: '宏观/季节性', note: '推断，需以 EIA 库存数据核实' },
  ], '近月对冬季合约升水较大，展期对多头不利。', ['寒潮', '暖冬'], [{ item: 'EIA 天然气库存周报', why: '供需平衡' }]),
};

// ---------------- 10 年日线（演示用合成数据，最后 90 天与上面的走势一致）与 CFTC 持仓 ----------------
const SEASON = { natgas: [6, 4, 0, -3, -4, -2, 1, 2, 3, 4, 5, 6], soybeans: [0, 1, 2, 2, 3, 2, -2, -4, -3, -1, 0, 0], corn: [0, 1, 1, 2, 3, 1, -3, -4, -2, 0, 0, 0], wheat: [1, 0, 0, 1, 2, -1, -3, -2, 0, 1, 1, 0], gold: [2, 1, 0, 0, 0, -1, 0, 1, 1, 0, 0, 1] };
let rng = 7;
const rnd = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const dailyBars = {};
const FACT = {};
for (const g of ['energy', 'metals', 'grains', 'equity']) FACT[g] = Array.from({ length: 2600 }, gauss);
const GROUP = { wti: ['energy', 0.9], brent: ['energy', 0.9], natgas: ['energy', 0.2], gold: ['metals', 0.6], silver: ['metals', 0.75], copper: ['equity', 0.4],
  soybeans: ['grains', 0.7], corn: ['grains', 0.75], wheat: ['grains', 0.6], es: ['equity', 0.95], nq: ['equity', 0.9], zn: ['equity', -0.4] };
for (const inst of INSTRUMENTS) {
  const recent = daily[inst.key];
  const [, dvol] = BASE[inst.key];
  const [g, rho] = GROUP[inst.key];
  const out = [];
  let c = recent[0].close, k = 0;
  // 从 90 天前往回生成约 10 年（倒序随机游走），带季节性和品种间联动
  for (let n = 1; n <= 2520; n++) {
    const t = (recent[0].ts - n * 1.45 * D) | 0;
    const d = new Date(t * 1000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const seas = (SEASON[inst.key]?.[d.getUTCMonth()] || 0) / 100 / 21;
    const shock = rho * FACT[g][k] + Math.sqrt(1 - rho * rho) * gauss();
    k++;
    c = c / Math.exp(dvol * shock * 0.9 + seas);
    out.push({ day: d.toISOString().slice(0, 10), close: c });
  }
  out.reverse();
  const all = [...out, ...recent.map((r) => ({ day: r.day, close: r.close }))];
  dailyBars[inst.key] = all.map((b, i) => {
    const prev = i ? all[i - 1].close : b.close;
    const hi = Math.max(prev, b.close) * (1 + dvol * 0.4), lo = Math.min(prev, b.close) * (1 - dvol * 0.4);
    return { day: b.day, open: prev, high: hi, low: lo, close: b.close, volume: 100000 };
  }).filter((b, i, arr) => i === 0 || b.day !== arr[i - 1].day);
}
const cotBy = {};
INSTRUMENTS.forEach((inst, i) => {
  const oi = { wti: 1900000, brent: 400000, natgas: 1500000, gold: 520000, silver: 160000, copper: 230000, soybeans: 800000, corn: 1500000, wheat: 420000, es: 2100000, nq: 260000, zn: 4500000 }[inst.key];
  const mean = { wti: 0.1, brent: 0.15, natgas: -0.08, gold: 0.35, silver: 0.2, copper: 0.05, soybeans: 0.05, corn: -0.05, wheat: -0.12, es: -0.05, nq: 0.02, zn: -0.12 }[inst.key];
  let x = mean + 0.08 * gauss();
  const rows = [];
  for (let w = 159; w >= 0; w--) {
    x = mean + 0.92 * (x - mean) + 0.025 * gauss();
    const date = new Date((NOW - w * 7 * D - 4 * D) * 1000).toISOString().slice(0, 10);
    const long = Math.round(oi * (0.18 + Math.max(0, x))), short = Math.round(oi * (0.18 + Math.max(0, -x)));
    rows.push({ report_date: date, open_interest: oi, long, short });
  }
  cotBy[inst.key] = rows;
});

// ---------------- 品种列表与详情 ----------------
const evRel = (key) => RAW.map((r, i) => ({ r, id: i + 1 })).filter(({ r }) => r.impact.assets.some((a) => a.instrument === key))
  .map(({ r, id }) => { const a = r.impact.assets.find((x) => x.instrument === key); const e = events.find((x) => x.id === id); return { id, title: r.title_zh, severity: e.severity, level: e.level, updated: e.last_updated_at, direction: a.direction, horizon: a.horizon, rationale: a.rationale }; });
const hit = (key) => {
  let h = 0, m = 0, ins = 0;
  for (const d of Object.values(details)) for (const r of d.event.market?.instruments || []) if (r.key === key) { if (r.verdict === 'hit') h++; else if (r.verdict === 'miss') m++; else if (r.verdict === 'insignificant') ins++; }
  return { hit: h, miss: m, insignificant: ins, hit_rate: h + m ? h / (h + m) : null };
};
const today = iso(NOW).slice(0, 10);
const instruments = [], instrumentDetails = {};
for (const inst of INSTRUMENTS) {
  const stats = computeStats(daily[inst.key]);
  const bars = dailyBars[inst.key];
  const cot = cotMetrics(cotBy[inst.key]);
  const snap = { contract: curves[inst.key].active, stats, daily: daily[inst.key].map((d) => [d.ts, +d.close.toFixed(4)]), curve: curves[inst.key], updated_at: iso(NOW - 900),
    perf: performance(bars), tech: technicals(bars), pivots: pivots(bars[bars.length - 1]), seasonality: seasonality(bars), cot: { ...cot, group: COT_GROUP_LABEL[inst.cftc.report] } };
  const b = BRIEFS[inst.key];
  instruments.push({ key: inst.key, name: inst.name, sector: inst.sector, unit: inst.unit, root: inst.root, contract: snap.contract, stats, spark: snap.daily.slice(-30).map((d) => d[1]),
    structure: curves[inst.key].metrics.structure, roll_yield_ann_pct: curves[inst.key].metrics.roll_yield_ann_pct, brief: b ? { day: today, headline: b.headline, price_action: b.price_action } : null, updated_at: snap.updated_at,
    perf: { d1: snap.perf.d1, w1: snap.perf.w1, m1: snap.perf.m1, m3: snap.perf.m3, ytd: snap.perf.ytd, y1: snap.perf.y1, pos52: snap.perf.pos52 }, rsi14: snap.tech.rsi14,
    cot: { net: cot.net, net_change: cot.net_change, net_pct_oi: cot.net_pct_oi, cot_index: cot.cot_index, state: cot.state, report_date: cot.report_date, group: COT_GROUP_LABEL[inst.cftc.report] } });
  instrumentDetails[inst.key] = {
    instrument: { key: inst.key, name: inst.name, sector: inst.sector, unit: inst.unit, root: inst.root, exchange: inst.exchange, months: inst.months, spec: inst.spec, session_hours: SESSION_LABEL[inst.spec.session], cftc_code: inst.cftc.code },
    snapshot: snap,
    brief: b ? { day: today, created_at: iso(NOW - 3 * H), model: 'glm:glm-4.7-flash（演示）', ...b } : null,
    events: evRel(inst.key),
    hit_rate: hit(inst.key),
  };
}

// ---------------- 校准统计 ----------------
const ms = Object.values(details).map((d) => d.event.market).filter(Boolean);
const per = {};
let hits = 0, misses = 0, insig = 0;
const diffs = [];
for (const m of ms) {
  hits += m.hits; misses += m.misses; insig += m.insignificant;
  if (m.observed_score !== null && m.weight > 0) diffs.push(m.model_score - m.observed_score);
  for (const r of m.instruments) if (['hit', 'miss'].includes(r.verdict)) { const x = (per[r.key] ||= { name: r.name, hit: 0, miss: 0 }); x[r.verdict]++; }
}
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const calibration = { events: ms.length, direction: { hits, misses, insignificant: insig, hit_rate: hits + misses ? Math.round((hits / (hits + misses)) * 1000) / 1000 : null },
  market_shock: { n: diffs.length, bias: avg(diffs), mae: avg(diffs.map(Math.abs)) },
  by_instrument: Object.entries(per).map(([key, x]) => ({ key, ...x, hit_rate: Math.round((x.hit / (x.hit + x.miss)) * 1000) / 1000 })) };

// ---------------- 小时行情与一小时风险展望 ----------------
// 演示时间若遇休市，就往前找最近一个开盘的整点作为"当前窗口"
const DEMO_AI = {
  wti: { context: '[演示] 本小时无数据发布，油价延续早盘区间整理', upside: '若中东航运消息再度紧张，价格可能冲向区间上沿', downside: '若美元走强或风险偏好回落，可能回到区间下沿', watch: '霍尔木兹海峡航运动态' },
  brent: { context: '[演示] 与 WTI 同步，价差稳定', upside: '欧洲炼厂需求数据好于预期时可能走强', downside: '若 OPEC+ 增产传闻发酵，可能承压', watch: '布伦特-WTI 价差' },
  gold: { context: '[演示] 美元指数小幅走弱', upside: '若美债收益率继续回落，金价可能向上沿运动', downside: '若美联储官员讲话偏鹰，可能回落', watch: '10 年期美债收益率' },
  es: { context: '[演示] 美股盘前，科技股财报季', upside: '大型科技股盘前走强时可能带动指数上行', downside: '若经济数据弱于预期，可能下探区间下沿', watch: '纳指期货与美元指数' },
};
let olNow = Math.floor(NOW / H) * H + 600;
while (!isOpen('globex', new Date(olNow * 1000))) olNow -= H;
const hourlyDemo = {}, olRows = {};
let tot = { n: 0, h68: 0, h95: 0 };
const trackBy = [];
for (const inst of INSTRUMENTS) {
  // 合成数据的时间戳不在整点：对齐到整点并补上开高低，模拟交易所的小时K线
  const rows = [];
  let prev = null;
  for (const p of hourly[inst.key]) {
    const ts = Math.floor(p.ts / H) * H;
    if (rows.length && rows.at(-1).ts === ts) continue;
    if (!isOpen(inst.spec.session, new Date((ts + 1800) * 1000))) { prev = p.close; continue; }
    const o = prev ?? p.close, w = Math.abs(p.close - o) * 0.4 + p.close * 0.0006;
    rows.push({ ts, open: o, high: Math.max(o, p.close) + w * 0.5, low: Math.min(o, p.close) - w * 0.5, close: p.close });
    prev = p.close;
  }
  const upTo = rows.filter((r) => priceTime(r) <= olNow - 600);
  const stats = hourStats(upTo);
  const cur = computeOutlook(inst, upTo, { nowSec: olNow, stats, events: [] });
  // 最近 24 个整点：用当时可得的数据生成区间，再用之后的收盘核对
  const hist = [];
  for (let w = olNow - 24 * H; w < olNow - H; w += H) {
    const known = rows.filter((r) => priceTime(r) <= w);
    const o = computeOutlook(inst, known, { nowSec: w + 600, stats: hourStats(known) });
    if (o.status !== 'open') continue;
    const act = rows.find((r) => priceTime(r) === o.window_end);
    if (!act) continue;
    const hit68 = act.close >= o.lo68 && act.close <= o.hi68 ? 1 : 0, hit95 = act.close >= o.lo95 && act.close <= o.hi95 ? 1 : 0;
    hist.push({ window_start: iso(o.window_start), window_end: iso(o.window_end), base_price: o.base_price, lo68: o.lo68, hi68: o.hi68, lo95: o.lo95, hi95: o.hi95, actual: +act.close.toFixed(6), hit68, hit95, evaluated: true });
  }
  const h68 = hist.reduce((a, h) => a + h.hit68, 0), h95 = hist.reduce((a, h) => a + h.hit95, 0);
  tot = { n: tot.n + hist.length, h68: tot.h68 + h68, h95: tot.h95 + h95 };
  const tr = { key: inst.key, name: inst.name, n: hist.length, hit68: hist.length ? +(h68 / hist.length).toFixed(3) : null, hit95: hist.length ? +(h95 / hist.length).toFixed(3) : null,
    above68: hist.filter((h) => h.actual > h.hi68).length, below68: hist.filter((h) => h.actual < h.lo68).length };
  trackBy.push(tr);
  const current = cur.status === 'open' ? { ...cur, window_start: iso(cur.window_start), window_end: iso(cur.window_end), made_at: iso(cur.made_at), base_time: iso(cur.base_ts), status: 'current', instrument: inst.key, name: inst.name, unit: inst.unit, ai: DEMO_AI[inst.key] || null } : null;
  olRows[inst.key] = current || { instrument: inst.key, name: inst.name, status: 'closed' };
  hourlyDemo[inst.key] = { instrument: inst.key, contract: curves[inst.key].active, candles: hourlyCandles(rows.filter((r) => r.ts <= olNow - H), 72), current, session_open: !!current,
    history: hist.reverse(), hour_profile: stats ? Object.entries(stats.hour).map(([h, v]) => ({ hour: Number(h), sigma_pct: +(v.sigma * 100).toFixed(4), n: v.n })) : [],
    track: { days: 30, target68: 0.683, target95: 0.954, overall: {}, by_instrument: [tr] } };
}
// 5 分钟K线（演示）：在最近 24 根小时K线内部用布朗桥插值，首尾与小时K线的开收盘一致
const intradayDemo = {};
for (const inst of INSTRUMENTS) {
  const hs = hourlyDemo[inst.key].candles.slice(-24);
  const out = [];
  for (const h of hs) {
    const sig = Math.abs(Math.log(h.h / h.l)) / 4 || 0.0005;
    let path = [Math.log(h.o)];
    for (let k = 1; k <= 12; k++) path.push(path[k - 1] + gauss() * sig);
    const drift = (Math.log(h.c) - path[12]) / 12;
    path = path.map((v, k) => v + drift * k);
    for (let k = 0; k < 12; k++) {
      const o = Math.exp(path[k]), c = Math.exp(path[k + 1]);
      out.push({ t: h.t + k * 300, o: +o.toFixed(6), h: +(Math.max(o, c) * (1 + sig * 0.3)).toFixed(6), l: +(Math.min(o, c) * (1 - sig * 0.3)).toFixed(6), c: +c.toFixed(6), chg_pct: +((c / o - 1) * 100).toFixed(3) });
    }
  }
  if (out.length) out.at(-1).partial = true;
  intradayDemo[inst.key] = { instrument: inst.key, contract: curves[inst.key].active, candles: out };
}
const rate = (a, n) => (n ? +(a / n).toFixed(3) : null);
const outlookTrack = { days: 30, target68: 0.683, target95: 0.954, overall: { n: tot.n, hit68: rate(tot.h68, tot.n), hit95: rate(tot.h95, tot.n) }, by_instrument: trackBy };
const outlook = { now: iso(NOW), window_start: iso(Math.floor(olNow / H) * H), commentary_model: 'groq（演示）', instruments: INSTRUMENTS.map((i) => olRows[i.key]), track: outlookTrack };

// ---------------- 总览 ----------------
const nowMs = NOW * 1000;
const overview = {
  instruments: instruments.map((i) => ({ ...i, notional: notional(i.stats?.last, byKey[i.key].spec) })),
  correlation: correlationMatrix(dailyBars, INSTRUMENTS.map((i) => i.key), 60),
  spreads: SPREADS.map((d) => spreadStats(dailyBars, d)).filter(Boolean),
  overview_updated_at: iso(NOW - 900),
  calendar: [...recurringEvents(nowMs, 7), { ts: iso(NOW + 3 * D + 5 * H), title: '[演示] 自定义事件：美联储利率决议', instruments: ['es', 'nq', 'zn', 'gold'], importance: 3, source: 'custom' }].sort((a, b) => a.ts.localeCompare(b.ts)),
  top_events: events.filter((e) => e.status === 'analyzed').sort((a, b) => b.severity - a.severity).map((e) => ({ id: e.id, title: e.title, severity: e.severity, level: e.level, sectors: e.sectors, last_updated_at: e.last_updated_at })),
};

writeFileSync(new URL('../public/demo.json', import.meta.url), JSON.stringify({ events, details, calibration, instruments, instrumentDetails, overview, outlook, hourly: hourlyDemo, intraday: intradayDemo }));
for (const d of Object.values(details)) if (d.event.market) console.log(d.event.id, d.event.title_zh, 'model', d.event.market.model_score, '→', d.event.market.blended_score, d.event.market.instruments.map((r) => `${r.key}:${r.z}:${r.verdict}`).join(' '));
console.log('一小时区间（演示回测）', outlookTrack.overall);
console.log(instruments.map((i) => `${i.key} ${i.contract} ${i.stats.last.toFixed(2)} ${i.structure}`).join('\n'));
