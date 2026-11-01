// Claude API 单价（美元 / 百万 token），2026-11 核对自 platform.claude.com/docs/en/about-claude/pricing
// 价格变动时改这里即可；未列出的模型按 Sonnet 价格保守计算。
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }, // 提示 ≤10 万 token 档
};

export function costOf(model, usage = {}) {
  const p = PRICES[model] || PRICES['claude-sonnet-5-5'];
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.output_tokens || 0) * p.output +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
      (usage.cache_read_input_tokens || 0) * p.cacheRead) /
    1e6
  );
}
