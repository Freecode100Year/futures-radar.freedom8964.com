#!/usr/bin/env bash
# 逐个录入密钥到 Cloudflare（输入不回显，不写入任何文件）。直接回车跳过某一项。
# 用法：./scripts/set-secrets.sh
set -euo pipefail
NAMES=(ADMIN_TOKEN ZHIPU_API_KEY OLLAMA_API_KEY GROQ_API_KEY OPENCODE_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY TWELVEDATA_API_KEY)
for n in "${NAMES[@]}"; do
  read -r -s -p "$n（回车跳过）: " v; echo
  if [[ -n "$v" ]]; then
    printf '%s' "$v" | npx wrangler secret put "$n" >/dev/null && echo "  ✓ $n 已保存"
  fi
done
echo "完成。部署后运行：curl -X POST https://<你的worker>/api/admin/llm/test -H \"Authorization: Bearer \$ADMIN_TOKEN\""
