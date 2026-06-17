# auth2api

[中文](./README_CN.md)

Additional ops docs:

- [VPS proxy migration runbook](./docs/vps-proxy-runbook.md)

`auth2api` is a lightweight OAuth-to-API proxy that turns your own upstream logins into local API endpoints.

It currently supports:

- `anthropic`: Claude OAuth
- `codex`: OpenAI "Sign in with ChatGPT" OAuth
- `cursor`: experimental Cursor account integration

The project is intentionally small: one proxy, a few upstream providers, multi-account routing, and admin tooling for local/self-hosted use.

## What It Does

- Exposes OpenAI-compatible endpoints: `POST /v1/chat/completions`, `POST /v1/responses`, `GET /v1/models`
- Exposes Anthropic-compatible endpoints: `POST /v1/messages`, `POST /v1/messages/count_tokens`
- Supports multiple accounts per provider with automatic account selection, failover, cooldown, refresh, and sticky routing
- Routes requests by model family instead of forcing one upstream for everything
- Supports API key tiers, per-key concurrency limits, and per-key 5-hour request quotas
- Includes admin endpoints for account snapshots, routing inspection, API key management, stats, reload, and daily reports
- Includes request tracing and observability helpers for debugging slow or failing traffic

## Requirements

- Node.js 20+
- At least one upstream account:
  - Claude account for `anthropic`
  - ChatGPT Plus/Pro for `codex`
  - Cursor desktop/browser login for `cursor` (experimental)

## Install

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## Login

Pick the provider with `--provider=`. Default is `anthropic`.

```bash
# Claude OAuth
node dist/index.js --login

# ChatGPT / Codex OAuth
node dist/index.js --login --provider=codex

# ChatGPT / Codex OAuth on a remote machine
node dist/index.js --login --provider=codex --manual

# Cursor browser login (experimental)
node dist/index.js --login --provider=cursor

# Import existing local Cursor desktop login
node dist/index.js --login --provider=cursor --cursor-import-local
node dist/index.js --login --provider=cursor --cursor-storage=/path/to/state.vscdb
```

Notes:

- Anthropic and Codex support browser callback login. `--manual` is useful on remote servers.
- Cursor uses a different browser deep-link flow or local token import.
- Running `--login` multiple times adds more accounts to the same provider pool.
- Successful login triggers `POST /admin/reload` automatically if the server is already running.

### `--routingExtra`

You can persist per-account routing hints during login:

```bash
node dist/index.js --login --provider=codex --routingExtra='{"bias":1,"level":"pro"}'
node dist/index.js --login --provider=codex --routingExtra='{"bias":1,"level":"pro","proxy":"http://127.0.0.1:7890"}'
```

Supported fields:

- `bias`: adjusts account-selection priority
- `level`: `lite` or `pro`
- `proxy`: per-account HTTP(S) proxy URL, for example `http://127.0.0.1:7890`

These values are stored with the token file and are reloaded by `POST /admin/reload`.

Notes:

- `proxy` currently uses a standard HTTP(S) proxy endpoint, which maps cleanly to Clash's `http-port` or `mixed-port`
- Selecting a specific Clash node in the UI does **not** give you a node-specific URL to paste into auth2api; in practice you usually point auth2api at Clash's local proxy endpoint such as `http://127.0.0.1:7890`
- If you need one auth2api account to stay on one egress route, that isolation has to be enforced on the Clash side; if multiple accounts share the same Clash port and you only flip the global Selector, they will all move together
- Cursor's main chat path still uses a custom direct HTTP/2 transport; `routingExtra.proxy` already covers most fetch-based flows (Anthropic/Codex upstream, refresh, models/usage), but **not yet** the primary Cursor chat stream

## Start The Server

```bash
node dist/index.js
```

Default address:

- `http://127.0.0.1:8317`

On first start, a bootstrap admin key is generated automatically and written to `config.yaml` if `bootstrap-admin-key` is empty.

## Routing Rules

Provider routing is model-driven:

- `cursor-*` and `cr/*` always go to `cursor`
- `gpt-5*`, `o*`, and `codex-*` go to `codex`
- `claude-*` and Anthropic aliases go to `anthropic`
- unknown models fall back to `anthropic`

### Cursor-exclusive mode

If `cursor` is the only provider with logged-in accounts, all model names are routed to Cursor automatically, including plain `claude-*` or `gpt-*` names. This makes Cursor-only deployments usable with off-the-shelf Anthropic/OpenAI clients without adding a `cursor-` prefix.

### `/v1/models`

`GET /v1/models` only lists models for providers that currently have accounts loaded.

Do not hardcode the README model table as the source of truth:

- Codex model availability is account-dependent and fetched dynamically
- Cursor model availability may come from its internal model list, with fallbacks when unavailable
- Anthropic/Cursor aliases and translation behavior evolve over time

## API Compatibility

### OpenAI-compatible endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`

### Anthropic-compatible endpoints

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

### Provider support matrix

| Endpoint | anthropic | codex | cursor |
| --- | --- | --- | --- |
| `POST /v1/chat/completions` | Yes | Yes | Yes |
| `POST /v1/responses` | Yes | Yes | Yes |
| `POST /v1/messages` | Yes | Yes | Yes |
| `POST /v1/messages/count_tokens` | Yes | `501` | `501` |

Implementation notes:

- `codex` is normalized through the internal Responses translator so Chat, Responses, and Anthropic-style requests can all share the upstream Codex backend.
- `cursor` only supports streaming upstream; non-stream clients are aggregated locally where needed.
- Cursor-backed `POST /v1/messages` is re-encoded as Anthropic Messages SSE for Claude Code compatibility.

## Configuration

Copy `config.example.yaml` to `config.yaml` and adjust it:

```yaml
host: ""
port: 8317

auth-dir: "~/.auth2api"
bootstrap-admin-key: "sk-bootstrap-admin"

api-key-tier-limits:
  lite:
    concurrency: 5
    max-requests-5h: 300
  pro:
    concurrencyMultiplier: 2
    max-requests-multiplier: 2
  admin:
    concurrencyMultiplier: 2
    max-requests-multiplier: 2

body-limit: "200mb"

timeouts:
  messages-ms: 120000
  stream-messages-ms: 600000
  count-tokens-ms: 30000

stats:
  enabled: true

observability:
  enabled: false
  trace:
    enabled: true
    retentionDays: 14
  report:
    enabled: false
    scheduleHour: 2
    timezone: "Asia/Shanghai"
    retentionDays: 14
    recipients:
      - "ops@example.com"

mail:
  provider: "resend"
  resend:
    apiKey: "re_xxx"
    from: "auth2api Report <report@example.com>"

debug: "off"

cloaking:
  cli-version: "2.1.88"
  entrypoint: "cli"
  codex:
    originator: "codex_cli_rs"
    cli-version: "0.125.0"
  cursor:
    client-version: "2.3.41"
    client-type: "ide"
    agent-base-url: "https://api2.cursor.sh"
    api-base-url: "https://api2.cursor.sh"
```

Important config areas:

- `auth-dir`: token, API key, stats, and observability storage
- `api-key-tier-limits`: per-tier concurrency and quota limits
- `stats.enabled`: enables request statistics persisted in `stats.jsonl`
- `observability.*`: enables trace collection and daily HTML reports
- `mail.*`: used by scheduled or manual daily report delivery
- `cloaking.*`: upstream request fingerprint/version settings
- `debug`: `off`, `errors`, or `verbose`

## Authentication And API Keys

All `/v1/*` endpoints require an API key.

Supported auth headers:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`

Admin endpoints require an enabled `admin` tier key.

API keys are stored in:

- `<auth-dir>/api-keys.json`

## Admin Endpoints

All `/admin/*` routes require an admin API key.

| Endpoint | Description |
| --- | --- |
| `GET /admin/accounts` | account snapshot by provider |
| `POST /admin/accounts/usage/refresh` | refresh usage for all or selected accounts |
| `GET /admin/accounts/decision` | inspect provider/account routing decisions |
| `GET /admin/stats` | aggregated request stats |
| `GET /admin/api-keys` | list API keys |
| `POST /admin/api-keys` | create API key |
| `POST /admin/api-keys/:id/enable` | enable API key |
| `POST /admin/api-keys/:id/disable` | disable API key |
| `POST /admin/reload` | reload tokens and API keys from disk |
| `POST /admin/reports/daily` | generate daily HTML report and optionally send email |

### Stats query behavior

`GET /admin/stats` supports:

- `date=YYYY-MM-DD`
- or `start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- optional `locale=zh-CN`

Limits:

- date range must stay within the last 7 days
- maximum span is 7 days

## Observability And Debugging

When observability is enabled:

- traces are written to `<auth-dir>/observability/traces/trace-YYYY-MM-DD.jsonl`
- daily reports are written to `<auth-dir>/observability/reports/daily-YYYY-MM-DD.html`

Helper scripts:

```bash
npm run obs:slow -- --date YYYY-MM-DD --limit 20
npm run obs:trace -- --date YYYY-MM-DD --trace-id <trace-id>
npm run obs:explain -- --date YYYY-MM-DD --trace-id <trace-id>
npm run obs:report -- --date YYYY-MM-DD [--send-email]

npm run auth:error-summary -- --date YYYY-MM-DD
npm run auth:error-trace -- --date YYYY-MM-DD
```

These scripts help inspect:

- slow requests
- a single trace event
- heuristic latency explanations
- manual daily report generation
- repeated auth/refresh failures

## Example Request

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      { "role": "user", "content": "Hello" }
    ]
  }'
```

## Docker

Build and run:

```bash
docker compose up --build -d
```

The included image starts with:

```bash
node dist/index.js --config=/config/config.yaml
```

If you use Docker, make sure `config.yaml` points `auth-dir` to a writable container path such as `/data`, because the compose file mounts:

- `./config.yaml:/config/config.yaml`
- volume `auth-data:/data`

## Development

```bash
npm run dev
npm run build
npm test
```

## Notes

- `codex` relays your ChatGPT account session and quota; use it only for your own account and at your own risk.
- `cursor` support is reverse-engineered and experimental; upstream protocol or version-gating changes may break it at any time.
