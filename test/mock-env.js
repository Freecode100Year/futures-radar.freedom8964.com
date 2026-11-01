// 测试用的 Cloudflare 绑定模拟：D1(node:sqlite) / Vectorize / Workers AI / Queue
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  _exec() {
    const s = this.db.prepare(this.sql);
    return /^\s*(select|with)|returning/i.test(this.sql) ? s.all(...this.args) : (s.run(...this.args), []);
  }
  async all() {
    return { results: this._exec().map((r) => ({ ...r })) };
  }
  async first() {
    const rows = this._exec();
    return rows[0] ? { ...rows[0] } : null;
  }
  async run() {
    this._exec();
    return { success: true };
  }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    _db: db,
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.all())),
  };
}

// 词袋哈希向量：同一事件的标题共享关键词 → 相似度高
export function fakeEmbedding(text) {
  const v = new Array(128).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]{4,}/g) || []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 128] += 1;
  }
  return v;
}

function cos(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; }
  return d / (Math.sqrt(x * y) || 1);
}

export function makeEnv(extra = {}) {
  const vectors = new Map();
  const queue = [];
  return {
    DB: makeD1(),
    AI: {
      _chat: null, // 测试可设置：async (model, input) => ({ response: '...' })
      async run(model, input) {
        if (input.text) return { data: input.text.map(fakeEmbedding) };
        if (!this._chat) throw new Error('Workers AI chat not mocked');
        return this._chat(model, input);
      },
    },
    VECTORIZE: {
      upsert: async (items) => items.forEach((it) => vectors.set(it.id, it)),
      query: async (vec, { topK }) => ({
        matches: [...vectors.values()]
          .map((it) => ({ id: it.id, score: cos(vec, it.values), metadata: it.metadata }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK),
      }),
    },
    QUEUE: { _q: queue, sendBatch: async (msgs) => queue.push(...msgs.map((m) => m.body)), send: async (b) => queue.push(b) },
    EMBED_MODEL: 'fake',
    TRIAGE_MODEL: 'claude-haiku-5-5',
    ANALYSIS_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_API_KEY: 'test',
    ADMIN_TOKEN: 'secret',
    CLUSTER_THRESHOLD: '0.5',
    ANALYSIS_COOLDOWN_MIN: '0',
    ...extra,
  };
}

/** 把队列里的消息交给 worker.queue 处理，直到清空 */
export async function drainQueue(worker, env) {
  while (env.QUEUE._q.length) {
    const bodies = env.QUEUE._q.splice(0, 10);
    const messages = bodies.map((body) => ({ body, ack() {}, retry() { throw new Error('retry: ' + JSON.stringify(body)); } }));
    await worker.queue({ messages }, env);
  }
}

// 可复现的合成小时行情：对数收益率 ~ N(0, sigma)，可在 jumpAt 之后叠加一次跳变
export function synthSeries({ start, end, sigma = 0.002, seed = 1, base = 100, jumpAt = null, jump = 0, step = 3600 }) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const out = [];
  let logp = Math.log(base);
  let jumped = false;
  for (let ts = start; ts <= end; ts += step) {
    logp += sigma * gauss();
    if (jumpAt !== null && !jumped && ts > jumpAt) { logp += jump; jumped = true; }
    out.push({ ts, close: Math.exp(logp) });
  }
  return out;
}
