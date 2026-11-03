import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, sanitize, generate, chainFor, selfTest, status, freeOpencodeModels, checkOpencodeModel, geminiRetry, secondsToPacificMidnight } from '../src/llm.js';
import { makeEnv } from './mock-env.js';

const schema = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 5 },
    tag: { type: 'string', enum: ['军事', '能源'] },
    items: { type: 'array', items: { type: 'object', properties: { d: { type: 'string', enum: ['上涨', '下跌'] } }, required: ['d'] } },
  },
  required: ['relevant', 'score', 'tag'],
};
const good = { relevant: true, score: 4, tag: '能源', items: [{ d: '上涨' }] };

test('extractJson：思考块、代码围栏、前后废话、尾逗号', () => {
  assert.deepEqual(extractJson('<think>嗯……{"a":0}</think>好的：\n```json\n{"a": 1,}\n```'), { a: 1 });
  assert.deepEqual(extractJson('结果如下 {"a": {"b": [1,2,]}} 以上'), { a: { b: [1, 2] } });
  assert.throws(() => extractJson('没有 JSON'), /没有 JSON/);
});

test('sanitize：可修的修，数组坏元素丢弃，缺必填或枚举错则失败', () => {
  const errs = [];
  const v = sanitize(schema, { relevant: 'true', score: '7', tag: ' 能源 ', items: [{ d: '上涨' }, { d: '横盘' }, 'x'] }, '$', errs);
  assert.deepEqual(v, { relevant: true, score: 5, tag: '能源', items: [{ d: '上涨' }] });
  const e2 = [];
  assert.equal(sanitize(schema, { relevant: true, score: 1, tag: '体育' }, '$', e2), null);
  assert.match(e2.join(), /不在/);
  const e3 = [];
  assert.equal(sanitize(schema, { relevant: true, tag: '军事' }, '$', e3), null);
  assert.match(e3.join(), /score/);
});

// ---- 路由 ----
let calls;
let behavior;
const openaiReply = (obj, model = 'm') => Response.json({ model, choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
globalThis.fetch = async (url, init) => {
  const host = new URL(url).host;
  const body = JSON.parse(init.body);
  calls.push(host);
  return behavior[host] ? behavior[host](body) : new Response('no mock', { status: 500 });
};
beforeEach(() => { calls = []; behavior = {}; });

const env = () => makeEnv({ ZHIPU_API_KEY: 'z', GROQ_API_KEY: 'g', OLLAMA_API_KEY: 'o', OPENROUTER_API_KEY: 'r', ANTHROPIC_API_KEY: undefined, OPENCODE_API_KEY: undefined });
const run = (e, chain, extra = {}) => generate(e, { chain, purpose: 'triage', system: 's', user: 'u', schema, maxTokens: 100, ...extra });

test('Workers AI 成功：走绑定，不发 HTTP；记账', async () => {
  const e = env();
  e.AI._chat = async (model, input) => {
    assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8');
    assert.match(input.messages[1].content, /\/no_think/);
    return { response: '<think>…</think>' + JSON.stringify(good) };
  };
  const r = await run(e, ['workersai', 'glm']);
  assert.equal(r.provider, 'workersai');
  assert.deepEqual(r.data, good);
  assert.equal(calls.length, 0);
  const u = e.DB._db.prepare('SELECT * FROM api_usage').get();
  assert.equal(u.model, 'workersai:@cf/qwen/qwen3-30b-a3b-fp8');
  assert.equal(u.cost_usd, 0);
});

test('限流 → 冷却并降级到下一家；冷却期间直接跳过', async () => {
  const e = env();
  behavior['open.bigmodel.cn'] = () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
  behavior['ollama.com'] = (b) => {
    assert.ok(b.format?.properties, 'Ollama 收到 JSON Schema 作为 format');
    return Response.json({ model: 'deepseek-v4-flash', message: { content: JSON.stringify(good) }, prompt_eval_count: 50, eval_count: 10 });
  };
  const r = await run(e, ['glm', 'ollama']);
  assert.equal(r.provider, 'ollama');
  assert.equal(r.model, 'ollama:deepseek-v4-flash');
  assert.equal(r.attempts[0].cooldown_s, 30);
  const st = e.DB._db.prepare("SELECT * FROM provider_state WHERE provider='glm'").get();
  assert.ok(st.cooldown_until > new Date().toISOString());

  calls = [];
  const r2 = await run(e, ['glm', 'ollama']);
  assert.match(r2.attempts[0].skipped, /冷却中/);
  assert.deepEqual(calls, ['ollama.com']);
});

test('输出不合格 → 把错误发回去修复一次', async () => {
  const e = env();
  let n = 0;
  behavior['open.bigmodel.cn'] = (b) => {
    n++;
    if (n === 1) return openaiReply({ relevant: true, score: 3, tag: '体育' });
    assert.match(b.messages[1].content, /上一次的输出不合格/);
    assert.equal(b.response_format.type, 'json_object');
    assert.deepEqual(b.thinking, { type: 'disabled' });
    return openaiReply(good, 'glm-4.7-flash');
  };
  const r = await run(e, ['glm']);
  assert.equal(r.attempts.at(-1).repaired, true);
  assert.equal(n, 2);
  assert.equal(e.DB._db.prepare('SELECT calls, failures FROM api_usage').get().failures, 1);
});

test('OpenRouter 不做修复重试（每天只有 50 次）；每日额度用完后跳过', async () => {
  const e = env();
  behavior['openrouter.ai'] = () => openaiReply('不是 JSON');
  await assert.rejects(run(e, ['openrouter']), /所有模型都失败/);
  assert.equal(calls.length, 1);

  e.DB._db.prepare("INSERT INTO api_usage (day, model, purpose, calls) VALUES (date('now'), 'openrouter:x', 'triage', 45)").run();
  calls = [];
  const err = await run(e, ['openrouter']).catch((x) => x);
  assert.match(err.attempts[0].skipped, /今日已用/);
  assert.equal(calls.length, 0);
});

test('Groq 单次提示超长时跳过（免费版每分钟 token 上限）；未配置的跳过', async () => {
  const e = env();
  behavior['api.groq.com'] = () => openaiReply(good);
  behavior['open.bigmodel.cn'] = () => openaiReply(good);
  const r = await run(e, ['opencode', 'groq', 'glm'], { user: 'x'.repeat(50000) });
  assert.equal(r.provider, 'glm');
  assert.equal(r.attempts[0].skipped, '未配置');
  assert.match(r.attempts[1].skipped, /超过单次上限/);
});

test('付费模型受每日预算约束', async () => {
  const e = env();
  e.ANTHROPIC_API_KEY = 'a';
  e.DAILY_BUDGET_USD = '1';
  e.DB._db.prepare("INSERT INTO api_usage (day, model, purpose, calls, cost_usd) VALUES (date('now'), 'claude-sonnet:claude-sonnet-5-5', 'analysis', 10, 1.2)").run();
  behavior['open.bigmodel.cn'] = () => openaiReply(good);
  const r = await run(e, ['claude-sonnet', 'glm']);
  assert.match(r.attempts[0].skipped, /预算/);
  assert.equal(r.provider, 'glm');
});

test('Claude：用工具调用拿结构化结果并按价格记账', async () => {
  const e = env();
  e.ANTHROPIC_API_KEY = 'a';
  behavior['api.anthropic.com'] = (b) => {
    assert.equal(b.tool_choice.name, 'triage');
    return Response.json({ content: [{ type: 'tool_use', input: good }], usage: { input_tokens: 1000, output_tokens: 100 } });
  };
  const r = await run(e, ['claude-haiku'], { toolName: 'triage' });
  assert.equal(r.model, 'claude-haiku:claude-haiku-5-5');
  const cost = e.DB._db.prepare('SELECT cost_usd FROM api_usage').get().cost_usd;
  assert.ok(Math.abs(cost - (1000 * 0.1 + 100 * 0.5) / 1e6) < 1e-12);
});

test('key 无效（401）冷却 6 小时', async () => {
  const e = env();
  behavior['api.groq.com'] = () => new Response('invalid key', { status: 401 });
  const err = await run(e, ['groq-fast']).catch((x) => x);
  assert.equal(err.attempts[0].cooldown_s, 21600);
});

test('调用链可用环境变量覆盖；自检与状态', async () => {
  const e = env();
  assert.deepEqual(chainFor(e, 'triage').slice(0, 3), ['workersai', 'groq-fast', 'glm']);
  e.CHAIN_TRIAGE = 'glm, nope ,ollama';
  assert.deepEqual(chainFor(e, 'triage'), ['glm', 'ollama']);
  assert.ok(!chainFor(e, 'analysis').includes('groq'), '深度分析链不含 Groq');

  e.AI._chat = async () => ({ response: '{"ok": true, "answer": 7}' });
  behavior['open.bigmodel.cn'] = () => openaiReply({ ok: true, answer: 7 });
  behavior['api.groq.com'] = () => new Response('bad', { status: 401 });
  const t = await selfTest(e);
  const by = Object.fromEntries(t.map((x) => [x.provider, x.status]));
  assert.equal(by.workersai, '正常');
  assert.equal(by.glm, '正常');
  assert.equal(by.groq, '失败');
  assert.equal(by.opencode, '未配置');
  const s = await status(e);
  assert.equal(s.providers.find((p) => p.id === 'openrouter').caps.requests, 45);
});

test('OpenCode 每天探测一次；已失效模型轮换到 Zen 目录里的免费 Chat Completions 模型', async () => {
  const e = env();
  e.OPENCODE_API_KEY = 'oc-test';
  e.OPENCODE_MODEL = 'retired-model';
  const catalog = [
    { id: 'paid-model', api: { 'chat-completions': {} }, cost: { text: { input: { price: 1 }, output: { price: 1 } } } },
    { id: 'free-model', api: { 'chat-completions': {} }, cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
    { id: 'no-chat', cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
  ];
  assert.deepEqual(freeOpencodeModels(catalog), ['free-model']);
  let catalogCalls = 0;
  let probeCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/models')) { catalogCalls++; return Response.json({ data: catalog }); }
    probeCalls++;
    assert.equal(JSON.parse(init.body).model, 'free-model');
    return Response.json({ model: 'free-model', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };

  const result = await checkOpencodeModel(e);
  assert.equal(result.status, '正常');
  assert.equal(result.model, 'free-model');
  assert.equal(e.DB._db.prepare('SELECT model FROM opencode_model_state').get().model, 'free-model');
  assert.equal(e.DB._db.prepare("SELECT calls FROM api_usage WHERE model='opencode:free-model'").get().calls, 1);

  const skipped = await checkOpencodeModel(e);
  assert.equal(skipped.status, '今日已检查');
  assert.equal(catalogCalls, 1);
  assert.equal(probeCalls, 1);
});

test('OpenCode 当前模型探测失败时继续试下一个免费模型', async () => {
  const e = env();
  e.OPENCODE_API_KEY = 'oc-test';
  e.OPENCODE_MODEL = 'deepseek-v4.1-flash-free';
  const models = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'].map((id) => ({
    id, api: { 'chat-completions': {} }, cost: { text: { input: { price: 0 }, output: { price: 0 } } },
  }));
  const attempted = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/models')) return Response.json({ data: models });
    const model = JSON.parse(init.body).model;
    attempted.push(model);
    if (model === 'deepseek-v4.1-flash-free') return new Response('unavailable', { status: 503 });
    return Response.json({ model, choices: [{ message: { content: 'ok' } }] });
  };

  const result = await checkOpencodeModel(e);
  assert.deepEqual(attempted, ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free']);
  assert.equal(result.status, '正常');
  assert.equal(result.model, 'glm-5.3-flash-free');
});

// ---- Gemini ----（前面的 OpenCode 测试替换过 fetch，这里恢复路由用的模拟）
const routerFetch = async (url, init) => {
  const host = new URL(url).host;
  calls.push(host);
  return behavior[host] ? behavior[host](JSON.parse(init.body)) : new Response('no mock', { status: 500 });
};
const geminiOk = (obj) => Response.json({ modelVersion: 'gemini-3.1-flash-lite', candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } });
const quota429 = (quotaId, retryDelay) => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
  ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
] } }), { status: 429 });

test('Gemini 429：区分每分钟限流和当天额度用完', () => {
  const t = Date.parse('2026-11-03T07:00:00Z'); // 太平洋时间 23:00
  assert.deepEqual(geminiRetry(429, JSON.stringify({ error: { details: [{ retryDelay: '37s' }] } }), t), { retryAfter: 37, daily: false });
  assert.deepEqual(geminiRetry(429, '{}', t), { retryAfter: 60, daily: false });
  const d = geminiRetry(429, JSON.stringify({ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }), t);
  assert.equal(d.daily, true);
  assert.equal(d.retryAfter, secondsToPacificMidnight(t));
  assert.ok(Math.abs(d.retryAfter - 3660) <= 1, '冷却到太平洋时间零点（约 1 小时后）');
  assert.equal(geminiRetry(500, '{}', t), null);
});

test('Gemini：每日上限可用 GEMINI_DAILY_REQUESTS 调整；当天额度用完时冷却到重置并换下一家', async () => {
  globalThis.fetch = routerFetch;
  const e = makeEnv({ GEMINI_API_KEY: 'k', ZHIPU_API_KEY: 'z', GEMINI_DAILY_REQUESTS: '2' });
  behavior['generativelanguage.googleapis.com'] = () => geminiOk(good);
  behavior['open.bigmodel.cn'] = () => openaiReply(good);
  assert.equal((await run(e, ['gemini', 'glm'])).provider, 'gemini');
  assert.equal((await run(e, ['gemini', 'glm'])).provider, 'gemini');
  const third = await run(e, ['gemini', 'glm']);
  assert.equal(third.provider, 'glm', '超过自设上限后不再请求 Gemini');
  assert.equal(calls.filter((h) => h === 'generativelanguage.googleapis.com').length, 2);

  const e2 = makeEnv({ GEMINI_API_KEY: 'k', ZHIPU_API_KEY: 'z' });
  behavior['generativelanguage.googleapis.com'] = () => quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  const r = await run(e2, ['gemini', 'glm']);
  assert.equal(r.provider, 'glm');
  const st = e2.DB._db.prepare("SELECT cooldown_until FROM provider_state WHERE provider = 'gemini'").get();
  assert.ok(Date.parse(st.cooldown_until) - Date.now() > 3600 * 1000 || secondsToPacificMidnight() < 3700, '冷却超过 1 小时（直到太平洋时间零点）');
});
