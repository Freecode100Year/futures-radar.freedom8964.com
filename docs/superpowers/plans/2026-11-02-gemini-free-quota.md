# Gemini Free Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the latest futures-radar version with Gemini 3.1 Flash-Lite available as a free fallback limited to 10 Worker requests per day.

**Architecture:** Fast-forward the clean local `main` to GitHub `origin/main`, then extend the existing D1-backed LLM provider registry and REST caller. Store `GEMINI_API_KEY` only as a Cloudflare Worker secret, configure a daily cap of 10 and route Gemini after Workers AI. Apply any migration required by the upstream release before deployment.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers, D1, Wrangler, Gemini Developer API REST.

**Spec:** `docs/superpowers/specs/2026-11-02-gemini-free-quota-design.md`

## Global Constraints

- Never write the Gemini API key into tracked files, command output, or Git history.
- Use `gemini-3.1-flash-lite`; do not use grounding, batch, or paid-only features.
- Gemini request cap is exactly 10 per UTC day in the Worker configuration.
- Do not run costly Gemini inference during deployment verification.

## Review Focus

- Missing key: Gemini must be skipped without an external request.
- Daily cap reached: no further Gemini request is made.
- Invalid or rate-limited response: existing fallback chain continues and cooldown is persisted.
- Non-text/empty response: existing JSON validation rejects it and falls back.
- Externally used key: the Worker cap does not constrain use outside this Worker; Google project billing/tier remains an account-level setting.

---

### Task 1: Update checkout and inspect release migration

**Files:**
- Modify: Git branch `main` by fast-forward only
- Read: `README.md`, `wrangler.toml`, and migrations from upstream

**Interfaces:**
- Consumes: current clean checkout at `1b549bef6dbea7c5e6f30ff8e7e0f1913c1a70ff`.
- Produces: local `main` at current `origin/main` (`02be0fa40c3c62860b6594b34851534145b3e41f`).

- [ ] Verify the checkout remains clean and fast-forward `main` to `origin/main`.
- [ ] Inspect the upstream release note and apply only a migration that Wrangler reports pending.

### Task 2: Add free Gemini provider and daily cap

**Files:**
- Modify: `src/llm.js`
- Modify: `wrangler.toml`
- Modify: `scripts/set-secrets.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: provider registry, OpenAI/Anthropic callers, `usageToday`, `capsOf`, `skipReason`, `generate`, and `status` in `src/llm.js`.
- Produces: provider id `gemini`, environment secret `GEMINI_API_KEY`, model environment `GEMINI_MODEL`, cap variable `GEMINI_DAILY_REQUESTS` defaulting to `10`.

- [ ] Add the provider and an HTTP caller for `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, passing the existing system/user prompt, JSON schema, and output token limit; parse candidate text and usage metadata into the existing `{ data, model, usage }` contract.
- [ ] Add Gemini after Workers AI in default analysis/triage/brief/outlook chains where upstream chain overrides do not exclude it; configure production cap to `10`.
- [ ] Add `GEMINI_API_KEY` to the secret helper and document provider, free model, cap, and limitation that the cap only governs this Worker.

### Task 3: Configure and deploy release

**Files:**
- Production secret: Cloudflare Worker secret `GEMINI_API_KEY`
- Production variables: `GEMINI_DAILY_REQUESTS=10`

**Interfaces:**
- Consumes: updated checkout at upstream release plus Gemini provider.
- Produces: deployed `news-radar` Worker and reported deployment status.

- [ ] Store the supplied key as a Cloudflare secret without echoing it.
- [ ] Confirm D1 migrations are current; apply only pending migrations described in upstream README.
- [ ] Deploy using the repository Wrangler configuration.
- [ ] Confirm deployed version/status and do not send a Gemini inference request.
