// 多模型路由：按调用链依次尝试，遇到限流 / 报错 / 输出不合格自动换下一家。
// 每家的免费额度、冷却状态、调用记账都存在 D1，跨 Worker 调用共享。
import { costOf } from './pricing.js';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 提供商注册表
//   caps.requests / caps.tokens：每日上限（留了余量，可用环境变量 <ID>_DAILY_REQUESTS 等覆盖）
//   maxPromptTokens：单次请求的提示长度上限（Groq 免费版按每分钟 token 限流，超过会直接被拒）
//   paid：计入 DAILY_BUDGET_USD
// ---------------------------------------------------------------------------
export const PROVIDERS = {
  workersai: {
    label: 'Cloudflare Workers AI', kind: 'workersai', model: '@cf/qwen/qwen3-30b-a3b-fp8', modelEnv: 'WORKERSAI_MODEL',
    // 免费 10,000 Neurons/天；按每百万 token 输入 $0.051 / 输出 $0.335、$0.011 = 1000 Neurons 估算，留 2000 余量
    caps: { neurons: 8000 }, priceIn: 0.051, priceOut: 0.335,
  },
  'groq-fast': {
    label: 'Groq Llama 3.1 8B', kind: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY', model: 'llama-3.1-8b-instant', modelEnv: 'GROQ_FAST_MODEL',
    caps: { requests: 14000, tokens: 480000 }, maxPromptTokens: 4500, jsonMode: true,
  },
  groq: {
    label: 'Groq Llama 3.3 70B', kind: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile', modelEnv: 'GROQ_MODEL',
    caps: { requests: 1000, tokens: 95000 }, maxPromptTokens: 9000, jsonMode: true,
  },
  glm: {
    label: '智谱 GLM-4.7-Flash', kind: 'openai', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    keyEnv: 'ZHIPU_API_KEY', model: 'glm-4.7-flash', modelEnv: 'GLM_MODEL',
    caps: {}, jsonMode: true, extra: { thinking: { type: 'disabled' } },
  },
  ollama: {
    label: 'Ollama Cloud', kind: 'ollama', url: 'https://ollama.com/api/chat',
    keyEnv: 'OLLAMA_API_KEY', model: 'deepseek-v4-flash', modelEnv: 'OLLAMA_MODEL',
    caps: { requests: 300 },
  },
  opencode: {
    label: 'OpenCode Zen', kind: 'openai', url: 'https://opencode.ai/zen/v1/chat/completions',
    keyEnv: 'OPENCODE_API_KEY', model: 'deepseek-v4-flash-free', modelEnv: 'OPENCODE_MODEL',
    caps: { requests: 200 }, jsonMode: false,
  },
  openrouter: {
    label: 'OpenRouter 免费模型', kind: 'openai', url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY', model: 'openrouter/free', modelEnv: 'OPENROUTER_MODEL',
    caps: { requests: 45 }, jsonMode: false, noRepair: true, // 每天只有 50 次，不浪费在修复重试上
    headers: { 'HTTP-Referer': 'https://github.com/news-radar', 'X-Title': 'News Radar' },
  },
  'claude-haiku': {
    label: 'Claude Haiku 5.5', kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5', modelEnv: 'TRIAGE_MODEL', paid: true, caps: {},
  },
  'claude-sonnet': {
    label: 'Claude Sonnet 5.5', kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5', modelEnv: 'ANALYSIS_MODEL', paid: true, caps: {},
  },
};

// 默认调用链（可用环境变量覆盖，逗号分隔）。没配 key 的提供商会被自动跳过。
export const DEFAULT_CHAINS = {
  // 分诊：量大、提示短、只要 4 个字段 → 先用额度最宽的
  triage: 'workersai,groq-fast,glm,groq,opencode,openrouter,claude-haiku',
  // 一般事件的深度分析：提示约 1 万 token、输出复杂 JSON → 先用能力强的免费模型；Groq 免费版每分钟 token 上限装不下，不放进来
  analysis: 'ollama,glm,opencode,workersai,openrouter,claude-haiku',
  // 重要事件（粗分 ≥4 或已判严重）：有 Anthropic key 时先用 Sonnet
  analysis_important: 'claude-sonnet,ollama,glm,opencode,workersai,openrouter,claude-haiku',
  // 每日品种解读：提示约 3K token，Groq 70B 装得下 → 也放进来
  brief: 'glm,ollama,groq,opencode,workersai,openrouter,claude-haiku',
};

export function chainFor(env, task) {
  const raw = env[`CHAIN_${task.toUpperCase()}`] || DEFAULT_CHAINS[task];
  return raw.split(',').map((s) => s.trim()).filter((id) => PROVIDERS[id]);
}

export function isConfigured(env, id) {
  const p = PROVIDERS[id];
  if (!p) return false;
  if (p.kind === 'workersai') return !!env.AI;
  return !!env[p.keyEnv];
}

const configuredModelOf = (env, id) => env[PROVIDERS[id].modelEnv] || PROVIDERS[id].model;
const modelOf = (env, id) => configuredModelOf(env, id);
async function selectedModelOf(env, id) {
  if (id !== 'opencode') return configuredModelOf(env, id);
  const selected = await env.DB.prepare('SELECT model FROM opencode_model_state WHERE provider = ?').bind(id).first();
  return selected?.model || configuredModelOf(env, id);
}

const OPENCODE_MODEL_CATALOG = 'https://opencode.ai/zen/v1/models';
const OPENCODE_MODEL_PREFERENCES = [
  'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle', 'beam-free', 'flint-40b-free',
  'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free',
];

export function freeOpencodeModels(models) {
  const ids = (Array.isArray(models) ? models : [])
    .filter((m) => m?.api?.['chat-completions'] && m.cost?.text?.input?.price === 0 && m.cost?.text?.output?.price === 0)
    .map((m) => m.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  const rank = (id) => {
    const i = OPENCODE_MODEL_PREFERENCES.indexOf(id);
    return i < 0 ? OPENCODE_MODEL_PREFERENCES.length : i;
  };
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// JSON：提示词描述、抽取、按 schema 清洗
// ---------------------------------------------------------------------------

export function schemaPrompt(schema) {
  return `只输出一个 JSON 对象，不要输出任何解释、Markdown 或代码块标记。JSON 必须符合下面的 JSON Schema（enum 字段只能取列出的值，required 字段必须出现）：\n${JSON.stringify(schema)}`;
}

/** 从模型回复里取出 JSON：去掉 <think> 块、代码围栏，截取第一个 { 到最后一个 } */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('回复中没有 JSON 对象');
  const body = t.slice(a, b + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 常见小毛病：尾逗号
    return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
  }
}

/**
 * 按 schema 清洗：类型可修的修（"3"→3），数组里不合格的元素直接丢弃，
 * 对象缺必填字段或枚举值不合法则整个对象作废。返回 { value, errors }，value 为 null 表示不可用。
 */
export function sanitize(schema, value, path = '$', errors = []) {
  const fail = (msg) => {
    errors.push(`${path}: ${msg}`);
    return null;
  };
  if (value === undefined || value === null) return fail('缺失');
  if (schema.enum) {
    const v = typeof value === 'string' ? value.trim() : value;
    return schema.enum.includes(v) ? v : fail(`取值 ${JSON.stringify(value)} 不在 ${schema.enum.join('/')} 中`);
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return fail('应为对象');
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (value[k] === undefined || value[k] === null) continue;
        const v = sanitize(sub, value[k], `${path}.${k}`, errors);
        if (v !== null) out[k] = v;
      }
      for (const k of schema.required || []) if (out[k] === undefined) return fail(`缺少必填字段 ${k}`);
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail('应为数组');
      return value.map((v, i) => sanitize(schema.items, v, `${path}[${i}]`, [])).filter((v) => v !== null);
    }
    case 'integer':
    case 'number': {
      let n = typeof value === 'string' ? Number(value.trim()) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail('应为数字');
      if (schema.type === 'integer') n = Math.round(n);
      if (schema.minimum !== undefined) n = Math.max(schema.minimum, n);
      if (schema.maximum !== undefined) n = Math.min(schema.maximum, n);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return fail('应为布尔值');
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fail('应为字符串');
    default:
      return value;
  }
}

export function estimateTokens(s) {
  let ascii = 0, other = 0;
  for (const ch of s) ch.charCodeAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4 + other);
}

// ---------------------------------------------------------------------------
// 各类提供商的请求实现。都返回 { text | data, usage: {input, output} }
// ---------------------------------------------------------------------------

class ProviderError extends Error {
  constructor(message, { status = 0, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function httpJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, { status: res.status, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null });
  }
  return res.json();
}

async function callOpenAI(env, id, { system, user, schema, maxTokens, model: modelOverride }) {
  const p = PROVIDERS[id];
  const body = {
    model: modelOverride || configuredModelOf(env, id),
    messages: [{ role: 'system', content: `${system}\n\n${schemaPrompt(schema)}` }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature: 0.2,
    ...(p.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(p.extra || {}),
  };
  const data = await httpJson(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env[p.keyEnv]}`, ...(p.headers || {}) },
    body: JSON.stringify(body),
  }, num(env.LLM_TIMEOUT_MS, 90000));
  const msg = data.choices?.[0]?.message;
  return {
    text: msg?.content ?? '',
    model: data.model || body.model,
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
  };
}

async function callOllama(env, id, { system, user, schema, maxTokens }) {
  const p = PROVIDERS[id];
  const body = {
    model: modelOf(env, id),
    stream: false,
    format: schema, // Ollama 原生结构化输出：直接传 JSON Schema
    options: { temperature: 0.2, num_predict: maxTokens },
    messages: [{ role: 'system', content: `${system}\n\n${schemaPrompt(schema)}` }, { role: 'user', content: user }],
  };
  const data = await httpJson(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env[p.keyEnv]}` },
    body: JSON.stringify(body),
  }, num(env.LLM_TIMEOUT_MS, 90000));
  return { text: data.message?.content ?? '', model: data.model || body.model, usage: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 } };
}

async function callWorkersAI(env, id, { system, user, schema, maxTokens }) {
  const model = modelOf(env, id);
  const input = {
    messages: [{ role: 'system', content: `${system}\n\n${schemaPrompt(schema)}` }, { role: 'user', content: `${user}\n\n/no_think` }],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  const opts = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined; // 走 AI Gateway 可在控制台看日志
  let res;
  try {
    res = await env.AI.run(model, input, opts);
  } catch (e) {
    const status = /\b429\b|rate|neuron|quota|limit/i.test(e.message) ? 429 : 500;
    throw new ProviderError(e.message, { status });
  }
  const text = res?.response ?? res?.choices?.[0]?.message?.content ?? '';
  const usage = res?.usage
    ? { input: res.usage.prompt_tokens ?? 0, output: res.usage.completion_tokens ?? 0 }
    : { input: estimateTokens(input.messages.map((m) => m.content).join('')), output: estimateTokens(typeof text === 'string' ? text : JSON.stringify(text)) };
  return { text, model, usage };
}

async function callAnthropic(env, id, { system, user, schema, maxTokens, toolName }) {
  const model = modelOf(env, id);
  const data = await httpJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: [{ name: toolName, description: '结构化输出', input_schema: schema }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: user }],
    }),
  }, num(env.LLM_TIMEOUT_MS, 90000));
  const block = data.content?.find((b) => b.type === 'tool_use');
  if (!block) throw new ProviderError('Claude 未返回结构化结果', { status: 502 });
  const u = data.usage || {};
  return { data: block.input, model, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
}

const CALLERS = { openai: callOpenAI, ollama: callOllama, workersai: callWorkersAI, anthropic: callAnthropic };

// ---------------------------------------------------------------------------
// 额度、冷却、记账
// ---------------------------------------------------------------------------

async function usageToday(env, id) {
  return (await env.DB.prepare(
    `SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
     FROM api_usage WHERE day = ? AND model LIKE ?`,
  ).bind(today(), `${id}:%`).first()) || { calls: 0, input: 0, output: 0 };
}

function capsOf(env, id) {
  const p = PROVIDERS[id];
  const k = id.toUpperCase().replace(/-/g, '_');
  return {
    requests: num(env[`${k}_DAILY_REQUESTS`], p.caps.requests ?? Infinity),
    tokens: num(env[`${k}_DAILY_TOKENS`], p.caps.tokens ?? Infinity),
    neurons: num(env[`${k}_DAILY_NEURONS`], p.caps.neurons ?? Infinity),
  };
}

const neuronsOf = (p, input, output) => ((input * p.priceIn + output * p.priceOut) / 1e6 / 0.011) * 1000;

/** 为什么跳过这个提供商；返回 null 表示可以用 */
async function skipReason(env, id, promptTokens, { spent, budget }) {
  const p = PROVIDERS[id];
  if (!isConfigured(env, id)) return '未配置';
  if (p.paid && spent >= budget) return `已达每日预算 $${budget}`;
  if (p.maxPromptTokens && promptTokens > p.maxPromptTokens) return `提示约 ${promptTokens} token，超过单次上限 ${p.maxPromptTokens}`;
  const st = await env.DB.prepare('SELECT cooldown_until, last_error FROM provider_state WHERE provider = ?').bind(id).first();
  if (st?.cooldown_until && st.cooldown_until > new Date().toISOString()) return `冷却中至 ${st.cooldown_until}`;
  const caps = capsOf(env, id);
  if (caps.requests < Infinity || caps.tokens < Infinity || caps.neurons < Infinity) {
    const u = await usageToday(env, id);
    if (u.calls >= caps.requests) return `今日已用 ${u.calls}/${caps.requests} 次`;
    if (u.input + u.output >= caps.tokens) return `今日已用 ${u.input + u.output}/${caps.tokens} token`;
    if (p.caps.neurons && neuronsOf(p, u.input, u.output) >= caps.neurons) return '今日 Neurons 额度将用完';
  }
  return null;
}

async function setCooldown(env, id, seconds, error) {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO provider_state (provider, cooldown_until, last_error, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET cooldown_until = excluded.cooldown_until, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).bind(id, until, String(error).slice(0, 300), new Date().toISOString()).run();
}

function cooldownFor(err) {
  if (err.retryAfter) return Math.min(err.retryAfter, 3600);
  if (err.status === 401 || err.status === 403) return 6 * 3600; // key 无效：别反复撞
  if (err.status === 402) return 6 * 3600; // 余额问题
  if (err.status === 429) return 600;
  if (err.status >= 500 || err.status === 0) return 300;
  return 0; // 400 等请求问题：不冷却，直接换下一家
}

async function record(env, id, model, purpose, usage, ok) {
  const p = PROVIDERS[id];
  const cost = p.paid ? costOf(model, { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite }) : 0;
  try {
    await env.DB.prepare(
      `INSERT INTO api_usage (day, model, purpose, calls, failures, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, model, purpose) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cost_usd = cost_usd + excluded.cost_usd`,
    ).bind(today(), `${id}:${model}`, purpose, ok ? 0 : 1, usage.input || 0, usage.output || 0, usage.cacheRead || 0, usage.cacheWrite || 0, cost).run();
  } catch (e) {
    console.error('record usage', e);
  }
}

/** 每日探测 OpenCode Zen 的免费模型；探测成功后把活动模型保存在 D1。 */
export async function checkOpencodeModel(env) {
  if (!isConfigured(env, 'opencode')) return { status: '未配置' };
  const day = today();
  const stored = await env.DB.prepare('SELECT model, checked_day, status FROM opencode_model_state WHERE provider = ?').bind('opencode').first();
  if (stored?.checked_day === day) return { status: '今日已检查', model: stored.model };

  const initialModel = stored?.model || configuredModelOf(env, 'opencode');
  await env.DB.prepare(
    `INSERT INTO opencode_model_state (provider, model, checked_day, status, last_error, updated_at)
     VALUES ('opencode', ?, ?, '检查中', NULL, ?)
     ON CONFLICT(provider) DO UPDATE SET checked_day = excluded.checked_day, status = excluded.status, last_error = NULL, updated_at = excluded.updated_at`,
  ).bind(initialModel, day, new Date().toISOString()).run();

  let models = [];
  let catalogError = null;
  try {
    const catalog = await httpJson(OPENCODE_MODEL_CATALOG, { headers: { accept: 'application/json' } }, 15000);
    models = freeOpencodeModels(catalog.data);
  } catch (err) {
    catalogError = err.message;
  }
  const availableModels = catalogError ? OPENCODE_MODEL_PREFERENCES : models;
  const candidates = availableModels.includes(initialModel)
    ? [initialModel, ...availableModels.filter((id) => id !== initialModel)]
    : availableModels;
  if (!candidates.length && !catalogError) catalogError = 'Zen 目录中没有免费 Chat Completions 模型';

  let lastError = catalogError;
  for (const model of candidates) {
    try {
      const data = await httpJson(PROVIDERS.opencode.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENCODE_API_KEY}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, temperature: 0 }),
      }, 20000);
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new ProviderError('模型未返回文本', { status: 502 });
      await record(env, 'opencode', data.model || model, 'healthcheck', {
        input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0,
      }, true);
      await env.DB.prepare(
        `UPDATE opencode_model_state SET model = ?, status = '正常', last_error = NULL, updated_at = ? WHERE provider = 'opencode'`,
      ).bind(data.model || model, new Date().toISOString()).run();
      return { status: '正常', model: data.model || model };
    } catch (err) {
      lastError = err.message;
      await record(env, 'opencode', model, 'healthcheck', { input: 0, output: 0 }, false);
    }
  }

  const error = lastError || 'OpenCode 没有可用的免费模型';
  if (candidates.length) {
    const cooldown = cooldownFor({ status: Number(error.match(/HTTP (\d+)/)?.[1] || 0) });
    if (cooldown) await setCooldown(env, 'opencode', cooldown, error);
  }
  await env.DB.prepare(
    `UPDATE opencode_model_state SET model = ?, status = '失败', last_error = ?, updated_at = ? WHERE provider = 'opencode'`,
  ).bind(initialModel, String(error).slice(0, 300), new Date().toISOString()).run();
  return { status: '失败', model: initialModel, error: String(error).slice(0, 300) };
}

export async function spentToday(env) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM api_usage WHERE day = ?').bind(today()).first();
  return r?.c || 0;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 依次尝试调用链中的提供商，返回第一个通过 schema 校验的结果。
 * @returns {{ data, provider, model, attempts }}
 */
export async function generate(env, { chain, purpose, system, user, schema, maxTokens = 4000, toolName = 'output' }) {
  const promptTokens = estimateTokens(system + user + JSON.stringify(schema));
  const budget = num(env.DAILY_BUDGET_USD, 2);
  const spent = await spentToday(env);
  const attempts = [];

  for (const id of chain) {
    const reason = await skipReason(env, id, promptTokens, { spent, budget });
    if (reason) {
      attempts.push({ provider: id, skipped: reason });
      continue;
    }
    const p = PROVIDERS[id];
    const selectedModel = await selectedModelOf(env, id);
    let userMsg = user;
    const tries = p.kind === 'anthropic' || p.noRepair ? 1 : 2; // 第二次把校验错误发回去让模型修正
    for (let t = 0; t < tries; t++) {
      let res;
      try {
        res = await CALLERS[p.kind](env, id, { system, user: userMsg, schema, maxTokens, toolName, model: selectedModel });
      } catch (err) {
        await record(env, id, selectedModel, purpose, { input: 0, output: 0 }, false);
        const cd = cooldownFor(err);
        if (cd) await setCooldown(env, id, cd, err.message);
        attempts.push({ provider: id, error: err.message, cooldown_s: cd });
        break; // 请求失败 → 换下一家
      }
      let parsed, errors = [];
      try {
        const raw = res.data ?? extractJson(res.text);
        parsed = sanitize(schema, raw, '$', errors);
      } catch (e) {
        errors = [e.message];
      }
      await record(env, id, res.model, purpose, res.usage, !!parsed);
      if (parsed) {
        attempts.push({ provider: id, ok: true, repaired: t > 0 });
        return { data: parsed, provider: id, model: `${id}:${res.model}`, attempts };
      }
      attempts.push({ provider: id, invalid: errors.slice(0, 5) });
      userMsg = `${user}\n\n你上一次的输出不合格：${errors.slice(0, 8).join('；')}。请严格按 JSON Schema 重新输出完整 JSON。`;
    }
  }
  const err = new Error(`所有模型都失败：${attempts.map((a) => `${a.provider}(${a.skipped || a.error || (a.invalid ? '输出不合格' : '')})`).join(' → ')}`);
  err.attempts = attempts;
  throw err;
}

/** 连通性自检：每个已配置的提供商发一个极小请求 */
export async function selfTest(env) {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, answer: { type: 'integer' } }, required: ['ok', 'answer'] };
  const out = [];
  for (const id of Object.keys(PROVIDERS)) {
    if (!isConfigured(env, id)) {
      out.push({ provider: id, label: PROVIDERS[id].label, status: '未配置' });
      continue;
    }
    const t0 = Date.now();
    const model = await selectedModelOf(env, id);
    try {
      const r = await CALLERS[PROVIDERS[id].kind](env, id, { system: '你是测试助手。', user: '3+4 等于几？把结果填进 answer，ok 填 true。', schema, maxTokens: 200, toolName: 'answer', model });
      const v = sanitize(schema, r.data ?? extractJson(r.text), '$', []);
      out.push({ provider: id, label: PROVIDERS[id].label, model: r.model, status: v?.answer === 7 ? '正常' : '能连通但输出不对', ms: Date.now() - t0, sample: v });
    } catch (e) {
      out.push({ provider: id, label: PROVIDERS[id].label, model, status: '失败', ms: Date.now() - t0, error: e.message });
    }
  }
  return out;
}

/** 状态页：调用链、配置情况、今日用量、冷却 */
export async function status(env) {
  const { results: state } = await env.DB.prepare('SELECT * FROM provider_state').all();
  const opencodeHealth = await env.DB.prepare('SELECT checked_day, status, last_error FROM opencode_model_state WHERE provider = ?').bind('opencode').first();
  const st = Object.fromEntries(state.map((s) => [s.provider, s]));
  const providers = [];
  for (const id of Object.keys(PROVIDERS)) {
    const u = await usageToday(env, id);
    const caps = capsOf(env, id);
    providers.push({
      id, label: PROVIDERS[id].label, model: await selectedModelOf(env, id), configured: isConfigured(env, id), paid: !!PROVIDERS[id].paid,
      today: u, caps: Object.fromEntries(Object.entries(caps).filter(([, v]) => v < Infinity)),
      cooldown_until: st[id]?.cooldown_until > new Date().toISOString() ? st[id].cooldown_until : null,
      last_error: st[id]?.last_error || null,
      ...(id === 'opencode' ? { model_health: opencodeHealth || null } : {}),
    });
  }
  return {
    chains: Object.fromEntries(Object.keys(DEFAULT_CHAINS).map((t) => [t, chainFor(env, t)])),
    budget_usd: num(env.DAILY_BUDGET_USD, 2), spent_today_usd: await spentToday(env), providers,
  };
}
