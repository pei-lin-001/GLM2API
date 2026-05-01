# GLM2API

OpenAI-compatible API bridge for **chat.z.ai** (Zhipu AI / GLM). Wraps the upstream chat service behind a standard OpenAI-compatible HTTP interface for direct use with Claude Code, Continue, Cline, and other agent CLIs.

## Why

chat.z.ai implements HMAC-based request signing, anonymous auth tokens, and client fingerprinting. This bridge reverse-engineers those mechanisms so any OpenAI-compatible client can use Z.ai models without modification.

## Quick Start

```bash
# Install
pnpm install

# Run (port 8788, no browser required)
pnpm zai:openai
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check with upstream FE-Version |
| GET | `/v1/models` | Live model list from upstream |
| POST | `/v1/chat/completions` | Chat with streaming and tool calling |

## Claude Code / Agent CLI Config

```json
{
  "apiKey": "",
  "baseURL": "http://127.0.0.1:8788/v1",
  "model": "glm-5"
}
```

## Features

- **Pure HTTP** — no browser, no Puppeteer, minimal footprint
- **Strict OpenAI Schema** — no non-standard response fields, works as drop-in API provider
- **Tool calling** — full OpenAI function calling with auto-repair mode
- **Streaming** — SSE with reasoning_content deltas
- **Dynamic models** — live model list from upstream API
- **HMAC signing** — reverse-engineered double-HMAC-SHA256 signature scheme
- **Auth management** — anonymous token with auto-refresh
- **Fingerprint context** — viewport, timezone, platform, locale emulation

## Tool Calling

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "glm-5",
    "messages": [{"role": "user", "content": "查询北京天气"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

The bridge includes a **tool repair mode**: if the model fails to output tool_calls when expected, it automatically re-prompts with a correction.

## Stress Test

```bash
pnpm zai:stress
```

Tests: model list, basic chat, tool cycle, concurrent burst.

## Linux One-Command Deploy

```bash
bash scripts/deploy-zai-linux.sh
```

Auto-installs Node.js (if needed), pnpm, dependencies, and starts as a background service.

```bash
bash scripts/deploy-zai-linux.sh status
bash scripts/deploy-zai-linux.sh logs
bash scripts/deploy-zai-linux.sh restart
bash scripts/deploy-zai-linux.sh stop
```

## Architecture

```
Claude Code / Agent CLI
        │
        ▼  OpenAI-compatible HTTP
┌───────────────────┐
│  Z.ai Bridge      │  HMAC signing + auth
│  (Node.js HTTP)   │  fingerprint context
└───────┬───────────┘
        │  Reverse-engineered API
        ▼
┌───────────────────┐
│  chat.z.ai        │
│  (Zhipu AI / GLM) │
└───────────────────┘
```

### Reverse-Engineered Mechanisms

1. **FE-Version extraction** — scraped from homepage HTML pattern `z-ai/frontend/{version}/_app/`
2. **Anonymous auth** — `POST /api/v1/auths/` returns guest token with TTL cache
3. **HMAC signature** — `SHA256(bucket_key, SHA256(secret, sorted_params|base64_prompt|timestamp))` where bucket = `floor(timestamp / 300000)`
4. **Chat creation** — `POST /api/v1/chats/new` creates a chat session before streaming
5. **Completion** — `POST /api/v2/chat/completions` with signature in query params and `X-Signature` header

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|---|---|---|
| `ZAI_OPENAI_PORT` | `8788` | Listen port |
| `ZAI_SIGNATURE_SECRET` | `key-@@@@)))()((9))-xxxx&&&%%%%%` | HMAC signing secret |
| `ZAI_UPSTREAM_BASE_URL` | `https://chat.z.ai` | Upstream URL |
| `ZAI_DEFAULT_MODEL` | `glm-5` | Default model |
| `ZAI_ENABLE_THINKING` | `true` | Enable reasoning/thinking |

## License

AGPL-3.0-only — same as upstream jshookmcp project.
