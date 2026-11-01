// 严重性评分体系（面向国际期货：能源 / 金属 / 农产品 / 金融期货）
// 模型只负责给每个维度打 0-5 分并说明理由；总分由代码按权重计算，保证可复现、可调整。

export const DIMENSIONS = {
  military_escalation: {
    label: '军事升级',
    weight: 0.15,
    scale: [
      '0 无军事因素',
      '1 言辞威胁、例行演习',
      '2 兵力调动、非常规演习、军售/援助升级',
      '3 有限冲突或打击、代理人冲突加剧',
      '4 持续交战、封锁关键通道',
      '5 大国直接冲突或核风险',
    ],
  },
  market_shock: {
    label: '市场冲击',
    weight: 0.20,
    scale: [
      '0 无可见市场影响',
      '1 个别资产轻微波动',
      '2 单一市场或板块明显波动',
      '3 多类资产联动（油价/汇率/利率/股指）',
      '4 剧烈波动、流动性紧张、熔断或央行紧急表态',
      '5 全球性金融危机级冲击',
    ],
  },
  systemic_contagion: {
    label: '系统性传导',
    weight: 0.15,
    scale: [
      '0 孤立事件',
      '1 单一传导渠道，影响有限',
      '2 影响一个关键供应链或贸易流',
      '3 多渠道传导（能源、贸易、金融、制裁）',
      '4 关键枢纽受阻（海峡、芯片、储备货币、支付系统）',
      '5 全球体系性中断',
    ],
  },
  supply_demand: {
    label: '供需冲击',
    weight: 0.20,
    scale: [
      '0 不影响任何期货品种的供需',
      '1 局部、短暂的供需扰动',
      '2 影响某品种区域性供需或库存预期',
      '3 影响全球供需 1% 以上，或改变库存/产量预期（如 OPEC 决议、USDA 大幅下调）',
      '4 主要产地或通道严重中断（全球供需 3% 以上）',
      '5 历史级短缺或过剩',
    ],
  },
  geographic_scope: {
    label: '地理范围',
    weight: 0.05,
    scale: ['0 地方', '1 单一国家局部', '2 单一国家', '3 区域多国', '4 多个大洲', '5 全球'],
  },
  persistence: {
    label: '持续性/不可逆',
    weight: 0.10,
    scale: [
      '0 一次性、已结束',
      '1 数日内可能平息',
      '2 数周',
      '3 数月，部分不可逆',
      '4 长期结构性改变（制裁体系、联盟重组）',
      '5 永久性格局改变',
    ],
  },
  escalation_momentum: {
    label: '升级势头',
    weight: 0.15,
    scale: [
      '0 明显降温/已解决',
      '1 趋于缓和',
      '2 僵持',
      '3 缓慢升级',
      '4 快速升级',
      '5 失控边缘',
    ],
  },
};

export const LEVELS = [
  { min: 80, name: '危急' },
  { min: 60, name: '严重' },
  { min: 40, name: '显著' },
  { min: 20, name: '关注' },
  { min: 0, name: '低' },
];

/** scores: { dim: { score: 0-5 } } → 0-100 */
export function computeSeverity(scores) {
  let total = 0;
  let weightSum = 0;
  for (const [key, def] of Object.entries(DIMENSIONS)) {
    const raw = Number(scores?.[key]?.score);
    if (!Number.isFinite(raw)) continue;
    const s = Math.max(0, Math.min(5, raw));
    total += def.weight * s;
    weightSum += def.weight;
  }
  if (weightSum === 0) return 0;
  return Math.round((total / weightSum / 5) * 1000) / 10;
}

export function levelOf(severity) {
  return LEVELS.find((l) => severity >= l.min).name;
}

export function rubricText() {
  return Object.entries(DIMENSIONS)
    .map(([key, d]) => `- ${key}（${d.label}，权重 ${d.weight}）:\n    ${d.scale.join('\n    ')}`)
    .join('\n');
}
