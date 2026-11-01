// Claude 分诊 + 深度分析。用 tool_choice 强制结构化输出，再由代码校验证据。
import { DIMENSIONS, computeSeverity, levelOf, rubricText } from './rubric.js';
import { INSTRUMENTS, INSTRUMENT_KEYS, SECTORS, byKey } from './instruments.js';
import { generate, chainFor } from './llm.js';
export { spentToday } from './llm.js';

const DOMAINS = ['地缘政治', '军事', '宏观经济', '货币政策', '能源', '金属', '农业', '天气', '贸易', '制裁', '供应链'];

// ---------- 分诊：便宜模型判断是否值得深度分析 ----------

const TRIAGE_TOOL = {
  name: 'triage',
  description: '判断事件是否属于金融/地缘政治/军事范畴，并粗估严重性',
  input_schema: {
    type: 'object',
    properties: {
      relevant: { type: 'boolean', description: '是否可能影响国际期货价格（能源、金属、农产品、股指/国债期货）' },
      sectors: { type: 'array', items: { type: 'string', enum: SECTORS }, description: '可能受影响的期货品类' },
      rough_severity: { type: 'integer', minimum: 0, maximum: 5 },
      domains: { type: 'array', items: { type: 'string', enum: DOMAINS } },
      title_zh: { type: 'string', description: '简洁的中文事件标题（不超过30字）' },
    },
    required: ['relevant', 'rough_severity', 'sectors', 'domains', 'title_zh'],
  },
};

export async function triageEvent(env, articles) {
  const list = articles
    .slice(0, 12)
    .map((a) => `- [${a.source_name}] ${a.title}${a.summary ? ' — ' + a.summary.slice(0, 200) : ''}`)
    .join('\n');
  const r = await generate(env, {
    chain: chainFor(env, 'triage'),
    purpose: 'triage',
    maxTokens: 400,
    toolName: TRIAGE_TOOL.name,
    schema: TRIAGE_TOOL.input_schema,
    system: '你是国际期货市场的新闻分诊员。判断事件是否可能影响原油、天然气、黄金、白银、铜、大豆、玉米、小麦、美股指期货或美债期货的价格。地缘冲突、产油国政策、库存与产量报告、天气与作物、央行与通胀数据、贸易与制裁都可能相关；娱乐、体育、社会新闻、个股日常财报标记为不相关。',
    user: `以下报道属于同一事件：\n${list}`,
  });
  return { ...r.data, model: r.model };
}

// ---------- 深度分析 ----------

const dirEnum = ['上涨', '下跌', '波动加剧', '不确定'];
const scoreProps = Object.fromEntries(
  Object.keys(DIMENSIONS).map((k) => [
    k,
    {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 5 },
        rationale: { type: 'string', description: '一两句理由' },
        source_ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['score', 'rationale', 'source_ids'],
    },
  ]),
);

const ANALYSIS_TOOL = {
  name: 'event_analysis',
  description: '对一个金融/地缘政治事件的结构化深度分析',
  input_schema: {
    type: 'object',
    properties: {
      title_zh: { type: 'string' },
      summary_zh: { type: 'string', description: '150字以内的事件概述' },
      domains: { type: 'array', items: { type: 'string', enum: DOMAINS } },
      scores: { type: 'object', properties: scoreProps, required: Object.keys(DIMENSIONS) },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: '基于信源数量与一致性的整体置信度' },
      impact: {
        type: 'object',
        properties: {
          regions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                lat: { type: 'number' },
                lon: { type: 'number' },
                role: { type: 'string', enum: ['发源地', '直接影响', '间接影响'] },
                note: { type: 'string' },
              },
              required: ['name', 'lat', 'lon', 'role'],
            },
          },
          sectors: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, direction: { type: 'string', enum: dirEnum }, note: { type: 'string' } },
              required: ['name', 'direction'],
            },
          },
          assets: {
            type: 'array',
            description: '受影响的期货品种，逐一列出（优先使用列表中的品种代码）',
            items: {
              type: 'object',
              properties: {
                asset: { type: 'string' },
                instrument: {
                  type: 'string',
                  enum: [...INSTRUMENT_KEYS, 'other'],
                  description: `对应的行情代码，用于事后核对市场实际反应：${INSTRUMENTS.map((i) => `${i.key}=${i.name}`).join('，')}；不在列表中填 other`,
                },
                direction: { type: 'string', enum: dirEnum },
                horizon: { type: 'string', enum: ['数日', '数周', '数月'] },
                rationale: { type: 'string' },
              },
              required: ['asset', 'instrument', 'direction', 'horizon', 'rationale'],
            },
          },
        },
        required: ['regions', 'sectors', 'assets'],
      },
      transmission_chain: {
        type: 'array',
        description: '从事件到期货价格的传导链（如 冲突→航运受阻→供应减少→原油升水），按因果顺序',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            mechanism: { type: 'string' },
            lag: { type: 'string', description: '时滞，如“即时”“1-2周”' },
          },
          required: ['from', 'to', 'mechanism'],
        },
      },
      timeline: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD；相对日期须按该信源发布时间换算' },
            time: { type: 'string', description: 'HH:MM UTC，可选' },
            date_precision: { type: 'string', enum: ['精确', '约略'] },
            event: { type: 'string', description: '中文描述' },
            source_ids: { type: 'array', items: { type: 'integer' } },
            quote: { type: 'string', description: '支撑该条目的原文短句，逐字摘录，不超过25词' },
            status: { type: 'string', enum: ['已证实', '单一信源', '存在矛盾'] },
          },
          required: ['date', 'date_precision', 'event', 'source_ids', 'quote', 'status'],
        },
      },
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            supporting: { type: 'array', items: { type: 'integer' } },
            contradicting: { type: 'array', items: { type: 'integer' } },
          },
          required: ['claim', 'supporting', 'contradicting'],
        },
      },
      scenarios: {
        type: 'array',
        description: '2-3个后续情景',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            likelihood: { type: 'string', enum: ['低', '中', '高'] },
            triggers: { type: 'string' },
            market_implication: { type: 'string' },
          },
          required: ['name', 'likelihood', 'triggers', 'market_implication'],
        },
      },
      watch_indicators: { type: 'array', items: { type: 'string' }, description: '值得跟踪的先行指标' },
    },
    required: ['title_zh', 'summary_zh', 'domains', 'scores', 'confidence', 'impact', 'transmission_chain', 'timeline', 'scenarios', 'watch_indicators'],
  },
};

const SYSTEM = `你是资深的国际期货市场分析师，覆盖能源（原油、天然气）、金属（黄金、白银、铜）、农产品（大豆、玉米、小麦）和金融期货（标普/纳指期货、美国10年期国债期货）。
分析事件如何通过供需、库存、运输、汇率、利率预期和避险情绪传导到期货价格，写清楚传导关系。
原则：
1. 只依据提供的信源 [S1]…[Sn]，每个结论都要标注 source_ids。信源未提及的内容不要编造；推断必须在理由中写明“推断”。
2. 时间线中的 quote 必须是对应信源原文的逐字摘录（可以是英文），系统会自动核对。
3. 相对日期（“周二”“昨天”）按该信源的发布时间换算成具体日期。
4. 区分事实与各方声明；信源说法冲突时写进 contradictions。
5. 严格按下列刻度打分，不要因为新闻措辞激烈就抬高分数：
${rubricText()}
6. 资产影响里的期货方向预测会在事后与主力合约的实际行情逐一核对（4/24/72 小时）。只列你有把握的品种，方向拿不准就填“不确定”，不要为凑数而列。
7. 这是事件影响分析，不是交易建议：不要给出买卖、目标价、止损或仓位建议。
8. 除 quote 外一律用简体中文输出。`;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function buildSourceBlock(articles, MAX_SOURCES = 15, MAX_CHARS = 2000) {
  // 最早 3 篇 + 最新的若干篇，兼顾起因与最新进展
  const sorted = [...articles].sort((a, b) => (a.published_at || '').localeCompare(b.published_at || ''));
  const picked = sorted.length <= MAX_SOURCES ? sorted : [...sorted.slice(0, 3), ...sorted.slice(-(MAX_SOURCES - 3))];
  return picked.map((a, i) => ({
    sid: i + 1,
    article: a,
    text: `[S${i + 1}] 来源: ${a.source_name} | 发布: ${a.published_at || '未知'} | ${a.url}\n标题: ${a.title}\n${(a.content || a.summary || '').slice(0, MAX_CHARS)}`,
  }));
}

/** task: 'analysis' | 'analysis_important'，决定使用哪条调用链 */
export async function analyzeEvent(env, articles, nowIso, task = 'analysis') {
  const sources = buildSourceBlock(articles, num(env.MAX_SOURCES, 15), num(env.MAX_SOURCE_CHARS, 2000));
  const user = `当前时间: ${nowIso}\n\n${sources.map((s) => s.text).join('\n\n---\n\n')}\n\n请输出完整的结构化分析。`;
  const r = await generate(env, {
    chain: chainFor(env, task),
    purpose: 'analysis',
    maxTokens: 8000,
    toolName: ANALYSIS_TOOL.name,
    schema: ANALYSIS_TOOL.input_schema,
    system: SYSTEM,
    user,
  });
  return { ...postProcess(r.data, sources), model: r.model, attempts: r.attempts };
}

// ---------- 校验：去掉无信源条目，核对引文 ----------

const norm = (s) => (s || '').toLowerCase().replace(/[\s"'“”‘’.,，。:;!?()\-—]+/g, ' ').trim();

export function postProcess(raw, sources) {
  const valid = new Set(sources.map((s) => s.sid));
  const keepIds = (ids) => (Array.isArray(ids) ? ids.filter((id) => valid.has(id)) : []);
  const sourceText = new Map(sources.map((s) => [s.sid, norm(`${s.article.title} ${s.article.content || ''} ${s.article.summary || ''}`)]));

  const scores = {};
  for (const key of Object.keys(DIMENSIONS)) {
    const s = raw.scores?.[key] || { score: 0, rationale: '模型未给出', source_ids: [] };
    scores[key] = { ...s, source_ids: keepIds(s.source_ids) };
  }

  let dropped = 0;
  const timeline = (raw.timeline || [])
    .map((t) => {
      const ids = keepIds(t.source_ids);
      const q = norm(t.quote);
      const verified = q.length >= 8 && ids.some((id) => sourceText.get(id)?.includes(q));
      return { ...t, source_ids: ids, verified };
    })
    .filter((t) => {
      const ok = t.source_ids.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date);
      if (!ok) dropped++;
      return ok;
    })
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

  const severity = computeSeverity(scores);
  const verifiedRatio = timeline.length ? timeline.filter((t) => t.verified).length / timeline.length : 0;

  return {
    ...raw,
    scores,
    timeline,
    contradictions: (raw.contradictions || []).map((c) => ({
      ...c,
      supporting: keepIds(c.supporting),
      contradicting: keepIds(c.contradicting),
    })),
    severity,
    level: levelOf(severity),
    // 受影响的期货品类：由资产列表里的品种代码推出，用于前端按品类筛选
    sectors: [...new Set((raw.impact?.assets || []).map((a) => byKey[a.instrument]?.sector).filter(Boolean))],
    quality: { dropped_timeline_items: dropped, verified_quote_ratio: Math.round(verifiedRatio * 100) / 100 },
    sources: sources.map((s) => ({
      sid: s.sid,
      article_id: s.article.id,
      title: s.article.title,
      source: s.article.source_name,
      url: s.article.url,
      published_at: s.article.published_at,
    })),
  };
}
