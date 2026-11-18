#!/usr/bin/env bash
# One real call to the free LLM (Groq by default). The key is read from .env.local and never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/services/advisor"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}" npx tsx "$ROOT/scripts/demo/bon2-real-llm-driver.ts"
