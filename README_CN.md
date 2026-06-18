# auth2api

[English](./README.md)

补充运维文档：

- [VPS 代理迁移手册](./docs/vps-proxy-runbook.md)
- 一键脚本位于 `scripts/`

`auth2api` 是一个轻量级 OAuth 转 API 代理，目标很直接：把你自己的上游登录态变成可在本地或自托管环境里调用的 API。

当前支持三个 provider：

- `anthropic`：Claude OAuth
- `codex`：OpenAI 的 “Sign in with ChatGPT” OAuth
- `cursor`：实验性的 Cursor 账号集成

项目刻意保持小而专注：一个代理、少量 provider、多账号路由，以及面向本地运维的管理和诊断能力。

## 能力概览

- 提供 OpenAI 兼容接口：`POST /v1/chat/completions`、`POST /v1/responses`、`GET /v1/models`
- 提供 Anthropic 兼容接口：`POST /v1/messages`、`POST /v1/messages/count_tokens`
- 每个 provider 支持多账号，具备自动选号、故障转移、冷却、刷新和粘性路由
- 支持账号级路由附加信息，`bias`、`level`、`proxy` 会随 token 一起持久化
- 按模型族自动路由到对应 provider，而不是把所有请求硬塞到同一个上游
- 支持 API key 分层、按 key 并发限制、按 key 的 5 小时请求额度
- 支持定时/手动 usage 刷新、请求 trace、HTML 日报和邮件发送
- 支持账号级出口代理，以及面向 VPS/nginx 的部署辅助脚本
- 提供账号快照、路由决策、API key 管理、统计、热重载、日报生成等管理接口
- 内置请求 trace 与 observability 工具，方便排查慢请求、失败请求和认证异常

## 运行要求

- Node.js 20+
- 至少一个上游账号：
  - `anthropic` 需要 Claude 账号
  - `codex` 需要 ChatGPT Plus / Pro
  - `cursor` 需要浏览器授权或本地 Cursor 登录态（实验性）

## 安装

```bash
git clone https://github.com/wangguohao/auth2api.git
cd auth2api
npm install
npm run build
```

如果你是在 Ubuntu 22.04 x64 的新 VPS 上迁移，建议直接按下面顺序跑：

```bash
sudo bash scripts/install-node20.sh
sudo bash scripts/clone-auth2api-install.sh
sudo bash scripts/install-nginx-domain.sh auth2api.wghcloud.com
```

其中最后一条命令里的域名请替换成你的实际域名。

## 登录

通过 `--provider=` 选择登录哪个 provider；默认是 `anthropic`。

```bash
# Claude OAuth
node dist/index.js --login

# ChatGPT / Codex OAuth
node dist/index.js --login --provider=codex

# 远程机器上走手动回填
node dist/index.js --login --provider=codex --manual

# Cursor 浏览器授权（实验性）
node dist/index.js --login --provider=cursor

# 导入本机 Cursor Desktop 登录态
node dist/index.js --login --provider=cursor --cursor-import-local
node dist/index.js --login --provider=cursor --cursor-storage=/path/to/state.vscdb
```

说明：

- Anthropic 和 Codex 支持浏览器回调登录；部署在远程机器时可用 `--manual`
- Cursor 走单独的 deep-link 浏览器流程，或直接导入本地登录态
- 多次执行 `--login` 会继续向同一个 provider 的账号池里追加账号
- 如果服务已经启动，登录成功后会自动触发一次 `POST /admin/reload`

### `--routingExtra`

登录时可以把账号路由偏好一起写入 token：

```bash
node dist/index.js --login --provider=codex --routingExtra='{"bias":1,"level":"pro"}'
node dist/index.js --login --provider=codex --routingExtra='{"bias":1,"level":"pro","proxy":"http://127.0.0.1:7890"}'
```

当前支持的字段：

- `bias`：调整选号优先级
- `level`：`lite` 或 `pro`
- `proxy`：账号级 HTTP(S) 代理地址，例如 `http://127.0.0.1:7890`

这些值会随 token 一起持久化，并在 `POST /admin/reload` 时重新加载。

说明：

- `proxy` 当前走的是标准 HTTP(S) 代理，最适合直接接 Clash 的 `http-port` 或 `mixed-port`
- 如果你在 Clash 里只是点选了某个节点，**这个节点本身不会直接变成一个可填的 URL**；auth2api 里通常填的是 Clash 本地代理入口，例如 `http://127.0.0.1:7890`
- 如果你想让某个 auth2api 账号固定走某一条线路，需要在 Clash 侧把该流量稳定导向目标节点；仅切换全局 Selector 而不做隔离时，所有走同一个 Clash 端口的账号都会一起切换
- Cursor 主聊天链路目前仍是自建 HTTP/2 直连传输；`routingExtra.proxy` 已覆盖大部分 fetch 请求（如 Anthropic/Codex 上游、refresh、models/usage），但 **Cursor 聊天主链路暂未接入账号级代理**

## 启动服务

```bash
node dist/index.js
```

默认监听：

- `http://127.0.0.1:8317`

如果 `bootstrap-admin-key` 为空，首次启动会自动生成并写回 `config.yaml`。

如果前面挂了 nginx，服务端会信任一跳反向代理，并优先从 `X-Forwarded-For` 提取真实客户端 IP，这样内置的 IP 限流不会全部落到 `127.0.0.1`。

## 路由规则

provider 路由由模型名驱动：

- `cursor-*` 和 `cr/*` 强制走 `cursor`
- `gpt-5*`、`o*`、`codex-*` 走 `codex`
- `claude-*` 以及 Anthropic 别名走 `anthropic`
- 未识别模型默认回退到 `anthropic`

### Cursor 独占模式

如果当前只有 `cursor` 登录了账号，而 `anthropic` 和 `codex` 都没有账号，那么所有模型名都会自动路由到 Cursor，包括裸的 `claude-*` 和 `gpt-*`。这意味着 Cursor-only 部署可以直接给现成的 Anthropic/OpenAI 客户端使用，不需要额外加 `cursor-` 前缀。

### `/v1/models`

`GET /v1/models` 只会列出当前已加载账号的 provider 的模型。

不要把 README 里的模型列表示例当成真实来源，原因是：

- Codex 模型集合和账号权限直接相关，运行时动态拉取
- Cursor 模型会优先走内部模型列表，拿不到时才使用 fallback
- Anthropic / Cursor 的别名和翻译逻辑可能继续演进

## 接口兼容性

### OpenAI 兼容接口

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`

### Anthropic 兼容接口

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

### Provider 支持矩阵

| Endpoint | anthropic | codex | cursor |
| --- | --- | --- | --- |
| `POST /v1/chat/completions` | 支持 | 支持 | 支持 |
| `POST /v1/responses` | 支持 | 支持 | 支持 |
| `POST /v1/messages` | 支持 | 支持 | 支持 |
| `POST /v1/messages/count_tokens` | 支持 | `501` | `501` |

实现说明：

- `codex` 通过内部 Responses 翻译链统一承接 Chat、Responses、Anthropic 风格请求
- `cursor` 上游只支持流式，必要时会在本地聚合后再返回给非流式客户端
- 当 `/v1/messages` 实际由 Cursor 提供服务时，会被重新编码成 Anthropic Messages SSE，以兼容 Claude Code

## 配置

把 `config.example.yaml` 复制为 `config.yaml` 后按需修改：

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

api-key-rate-limit:
  window-ms: 18000000
  max-requests: 300
  overrides:
    sk-special-key:
      window-ms: 18000000
      max-requests: 600

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

重点配置项：

- `auth-dir`：token、API key、统计与 trace 的存储目录
- `api-key-tier-limits`：按 tier 配置并发和额度
- `api-key-rate-limit`：按客户端 API key 配置请求窗口，支持对单个 key 做精确 override
- `stats.enabled`：是否记录请求统计并写入 `stats.jsonl`
- `observability.*`：是否采集 trace、生成 HTML 日报
- `mail.*`：日报邮件投递配置
- `cloaking.*`：上游请求指纹与版本号配置
- `debug`：`off`、`errors`、`verbose`

## 鉴权与 API Key

所有 `/v1/*` 接口都要求 API key。

支持两种鉴权头：

- `Authorization: Bearer <key>`
- `x-api-key: <key>`

所有 `/admin/*` 接口都要求一个启用中的 `admin` 级别 API key。

API key 持久化在：

- `<auth-dir>/api-keys.json`

## 管理接口

`/admin/*` 全部需要 admin API key。

| Endpoint | 说明 |
| --- | --- |
| `GET /admin/accounts` | 查看各 provider 的账号快照 |
| `POST /admin/accounts/usage/refresh` | 刷新全部或指定账号的 usage |
| `GET /admin/accounts/decision` | 查看 provider / account 路由决策 |
| `GET /admin/stats` | 查看聚合后的请求统计 |
| `GET /admin/api-keys` | 列出 API key |
| `POST /admin/api-keys` | 创建 API key |
| `POST /admin/api-keys/:id/enable` | 启用 API key |
| `POST /admin/api-keys/:id/disable` | 禁用 API key |
| `POST /admin/reload` | 从磁盘热重载 token 和 API key |
| `POST /admin/reports/daily` | 生成日报，可选发送邮件 |

### `/admin/stats` 查询规则

`GET /admin/stats` 支持：

- `date=YYYY-MM-DD`
- 或 `start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- 可选 `locale=zh-CN`

限制：

- 查询范围必须在最近 7 天内
- 单次跨度最多 7 天

## 可观测性与诊断

开启 observability 后：

- trace 会写到 `<auth-dir>/observability/traces/trace-YYYY-MM-DD.jsonl`
- HTML 日报会写到 `<auth-dir>/observability/reports/daily-YYYY-MM-DD.html`

辅助脚本：

```bash
npm run obs:slow -- --date YYYY-MM-DD --limit 20
npm run obs:trace -- --date YYYY-MM-DD --trace-id <trace-id>
npm run obs:explain -- --date YYYY-MM-DD --trace-id <trace-id>
npm run obs:report -- --date YYYY-MM-DD [--send-email]

npm run auth:error-summary -- --date YYYY-MM-DD
npm run auth:error-trace -- --date YYYY-MM-DD
```

这些脚本可用于：

- 查看当天最慢请求
- 查看单条 trace 原始事件
- 对慢请求做启发式耗时归因
- 手动触发日报生成
- 排查重复出现的登录/刷新失败

## VPS 部署说明

对于全新的 Ubuntu 22.04 x64 VPS，仓库内置了几条辅助脚本：

```bash
npm run deploy:node20
npm run deploy:clone-install
npm run deploy:nginx -- your-domain.example
npm run deploy:mihomo
npm run deploy:mihomo-instance -- \
  --source-yaml /path/to/source.yaml \
  --proxy-name "日本-TY-4" \
  --instance-name jp-ty-4 \
  --port 7890
```

说明：

- `deploy:nginx` 会把 nginx 反代配置成 HTTP/1.1，避免 SSE 和流式响应被错误降级
- `deploy:mihomo` 和 `deploy:mihomo-instance` 是可选项，用于需要账号级代理出口时快速落地
- `deploy:mihomo-instance` 有 4 个必填参数：源 YAML 路径、节点精确名称、实例名、本地监听端口
- 更完整的代理迁移和运维说明见 [docs/vps-proxy-runbook.md](./docs/vps-proxy-runbook.md)

## 请求示例

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

构建并启动：

```bash
docker compose up --build -d
```

镜像默认启动命令：

```bash
node dist/index.js --config=/config/config.yaml
```

如果走 Docker 部署，建议在 `config.yaml` 里把 `auth-dir` 指到容器内可写目录，比如 `/data`，因为 compose 默认挂载了：

- `./config.yaml:/config/config.yaml`
- 命名卷 `auth-data:/data`

## 开发

```bash
npm run dev
npm run build
npm test
```

## 说明

- `codex` 实际转发的是你的 ChatGPT 账号会话与额度，仅建议个人自用
- `cursor` 是逆向得到的实验性集成，上游协议或版本门禁变化时可能随时失效
