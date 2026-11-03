# Gemini 免费额度接入设计

## 意图

在期货雷达的 Cloudflare Worker 中接入 Gemini，使用 Google Gemini API 免费模型作为现有 LLM 路由的一个后备提供商；将 Gemini 请求限制在每日 10 次，并部署 GitHub `main` 最新版本。

## 目标与边界

- API key 仅作为 Cloudflare Worker secret 存储，不能进入源码、配置文件或 Git 历史。
- 在 D1 通过原子预占实现 Gemini 每日 10 次上限，按 Google API 配额使用的太平洋日期重置；正常调用、结构修复重试和连通性自检全部计入。
- 选择 Google 当前标示为免费档的 `gemini-3.1-flash-lite` 文本模型，不启用付费模型、Grounding 或其他收费功能。
- 将本地 `main` 快进到 `origin/main`，按 README 应用新版本所需的 D1 迁移，再部署 Worker。
- Gemini 项目计费层状态无法从仓库或 Cloudflare 验证；应用侧上限只约束本 Worker，不约束同一 key 的外部使用。

## 方案

1. 仅保存 API key：不能让当前应用使用 Gemini，因此不满足目标。
2. 增加 Gemini 路由、每日硬上限和 Worker secret，再部署（选定）：复用现有 provider 路由与 D1 记账，控制变更范围。
3. 仅在 Google 控制台依靠项目额度：无法确保该 Worker 在应用侧停止调用，也不属于本仓库可执行的部署路径。

## 实现决策

- 新 provider 通过 Gemini REST `generateContent` 接口调用，并接入现有 JSON 解析、错误冷却和 usage 记录机制。
- 默认模型为可配置的 `gemini-3.1-flash-lite`；Gemini 路由放在现有免费提供商之后，以减少额外调用。
- provider 硬上限为每个太平洋日期 10 次；配置只允许降低上限，不能提高；每个实际 HTTP 请求开始前原子预占额度，预占失败则不调用 Gemini。
- 新增 Gemini API key secret 名为 `GEMINI_API_KEY`。鉴于原 key 已出现在对话中，部署前优先使用轮换后的 key；若没有新 key，则先部署代码和上限配置，但不注入旧 key，Gemini 保持未启用。
- 更新 README 的提供商、密钥和配额说明。

## 验收

- 没有 Gemini key 时 provider 被跳过。
- 同时请求、修复重试、自检和跨午夜请求都不会绕过每个太平洋日期 10 次的原子上限。
- Gemini 成功响应可按现有 schema 处理并写入调用记录；失败时现有路由能降级到下一个 provider。
- 生产 Worker 使用 secret 注入 key，部署到最新 `main`，并有可读回验证的版本状态。
