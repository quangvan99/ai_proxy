# Antigravity Claude Proxy


A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude and Gemini models with **Claude Code CLI** and **OpenClaw / ClawdBot**.

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  Antigravity Cloud Code    │
│   (Anthropic     │     │  (Anthropic → Google│     │  (daily-cloudcode-pa.      │
│    API format)   │     │   Generative AI)    │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format**
2. Uses OAuth tokens from added Google accounts
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API
5. Converts responses back to **Anthropic format** with full thinking/streaming support

## Prerequisites

- **Node.js** 18 or later
- Google account(s) for authentication

---

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install
npm start
```

---

## Quick Start

### 1. Start the Proxy Server

```bash
npm start
```

The server runs on `http://localhost:8386` by default.

### 2. Add Google Account(s)

Add your Google account via OAuth:

```bash
# Desktop (opens browser)
npm run accounts:add

# Headless (Docker/SSH) - manual OAuth code entry
npm run accounts:add -- --no-browser
```

> For full account management options, run `npm run accounts`.

To use a custom port:

```bash
PORT=3001 npm start
```

### 3. Verify It's Working

```bash
# Health check
curl http://localhost:8386/health

# Check account status and quota limits
curl "http://localhost:8386/account-limits?format=table"
```

---

## Using with Claude Code CLI

### Configure Claude Code

Edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386",
    "ANTHROPIC_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5-thinking",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

Or to use Gemini models:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386",
    "ANTHROPIC_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-flash[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3-flash[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3-flash[1m]",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

### Load Environment Variables

Add the proxy settings to your shell profile:

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8386"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:8386'"
Add-Content $PROFILE "`$env:ANTHROPIC_AUTH_TOKEN = 'test'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:8386"
setx ANTHROPIC_AUTH_TOKEN "test"
```

Restart your terminal for changes to take effect.

### Run Claude Code

```bash
# Make sure the proxy is running first
npm start

# In another terminal, run Claude Code
claude
```

> **Note:** If Claude Code asks you to select a login method, add `"hasCompletedOnboarding": true` to `~/.claude.json` (macOS/Linux) or `%USERPROFILE%\.claude.json` (Windows), then restart your terminal and try again.

### Proxy Mode vs. Paid Mode

Toggle in **Settings** → **Claude CLI**:

| Feature | 🔌 Proxy Mode | 💳 Paid Mode |
| :--- | :--- | :--- |
| **Backend** | Local Server (Antigravity) | Official Anthropic Credits |
| **Cost** | Free (Google Cloud) | Paid (Anthropic Credits) |
| **Models** | Claude + Gemini | Claude Only |

**Paid Mode** automatically clears proxy settings so you can use your official Anthropic account directly.

### Multiple Claude Code Instances (Optional)

To run both the official Claude Code and Antigravity version simultaneously, add this alias:

**macOS / Linux:**

```bash
# Add to ~/.zshrc or ~/.bashrc
alias claude-antigravity='CLAUDE_CONFIG_DIR=~/.claude-account-antigravity ANTHROPIC_BASE_URL="http://localhost:8386" ANTHROPIC_AUTH_TOKEN="test" command claude'
```

**Windows (PowerShell):**

```powershell
# Add to $PROFILE
function claude-antigravity {
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account-antigravity"
    $env:ANTHROPIC_BASE_URL = "http://localhost:8386"
    $env:ANTHROPIC_AUTH_TOKEN = "test"
    claude
}
```

Then run `claude` for official API or `claude-antigravity` for this proxy.

---

## Documentation

- [Available Models](docs/models.md)
- [Multi-Account Load Balancing](docs/load-balancing.md)
- [Advanced Configuration](docs/configuration.md)
- [macOS Menu Bar App](docs/menubar-app.md)
- [OpenClaw / ClawdBot Integration](docs/openclaw.md)
- [API Endpoints](docs/api-endpoints.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Safety, Usage, and Risk Notices](docs/safety-notices.md)
- [Legal](docs/legal.md)
- [Development](docs/development.md)

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## So sánh 3 repo cho nhu cầu Claude Code

Ngày cập nhật: 2026-02-25

Tiêu chí theo yêu cầu:
1. Dễ sử dụng
2. Tích hợp sẵn cho Claude Code
3. Có nhiều mô hình code phù hợp

### So sánh nhanh

| Tiêu chí | antigravity-claude-proxy | 9router | ai_proxy |
|---|---|---|---|
| Dễ sử dụng | Dễ (CLI + WebUI riêng) | Rất dễ (dashboard đầy đủ, quản lý qua UI) | Trung bình (CLI là chính, nhẹ) |
| Tích hợp sẵn Claude Code | Tốt (endpoint Anthropic trực tiếp, xử lý request phụ của Claude CLI) | Khá (hỗ trợ Claude qua lớp translator + API chỉnh settings Claude) | Tốt (giữ luồng Anthropic cho Claude Code, xử lý request phụ của Claude CLI) |
| Đa mô hình code | Trung bình (chủ yếu Claude/Gemini) | Rộng nhất (nhiều provider + combo/fallback) | Khá rộng (Claude/Gemini + Codex + Cursor + GitHub) |
| Phù hợp khi cần "Claude Code native" | Cao | Trung bình | Cao |

### Điểm mạnh/yếu từng repo

#### antigravity-claude-proxy
Ưu điểm:
- Tập trung cho Claude Code, API gọn, hành vi sát Claude workflow.
- Có xử lý các request phụ của Claude CLI (`/api/event_logging/batch`, `POST /`).
- Có WebUI để quản lý account và cấu hình.

Hạn chế:
- Độ phủ model không rộng bằng 9router/ai_proxy.
- `/v1/messages/count_tokens` hiện trả `501` (chưa triển khai).

#### 9router
Ưu điểm:
- Dễ dùng nhất theo góc nhìn vận hành: dashboard, provider management, combo/fallback.
- Đa mô hình mạnh nhất (phù hợp khi muốn route nhiều nhà cung cấp).
- Có API hỗ trợ chỉnh `~/.claude/settings.json`.

Hạn chế:
- Luồng Claude đi qua lớp translate tổng quát (không "native-focused" bằng antigravity/ai_proxy).
- `count_tokens` là ước lượng.
- Có logic bypass cho một số pattern `claude-cli` (thực dụng cho ổn định, nhưng không thuần upstream behavior).

#### ai_proxy
Ưu điểm:
- Kế thừa lõi Claude-compatible từ antigravity (phù hợp Claude Code).
- Mở rộng thêm model family cho coding: Codex, Cursor, GitHub Copilot.
- Một cổng `/v1/messages` nhưng route theo family model.

Hạn chế:
- Ít test hơn antigravity và không có dashboard mạnh như 9router.
- `/v1/messages/count_tokens` hiện trả `501`.

### Kết luận theo yêu cầu

Với điều kiện nhấn mạnh: **"phải tích hợp sẵn cho Claude Code"** và đồng thời cần **nhiều mô hình code**:

- Lựa chọn phù hợp nhất: **`ai_proxy`**
  - Giữ tích hợp Claude Code theo kiểu native-compatible.
  - Có thêm Codex/Cursor/GitHub để mở rộng mô hình coding.

Nếu ưu tiên #1 là giao diện quản trị và đa provider cực rộng, có thể chọn `9router`, nhưng mức "native-focused cho Claude Code" không đậm bằng `ai_proxy`.

---

## License

MIT
