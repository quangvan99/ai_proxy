# AI Proxy

A proxy server that exposes an **Anthropic-compatible API** (`/v1/messages`) backed by multiple AI providers, letting you use Claude Code CLI with free or alternative AI backends.

## Supported Providers

| Provider | Models | Account Setup |
|---|---|---|
| **Antigravity** (Google Cloud Code) | Claude (claude-sonnet-4-5-thinking, claude-opus-4-5-thinking), Gemini (gemini-3-flash, gemini-3-pro) | Google OAuth |
| **Codex** (OpenAI) | gpt-5.3-codex, gpt-5.1-codex-mini, gpt-5.2-codex, ... | OpenAI OAuth (PKCE) |
| **Cursor** | claude-4.5-opus, claude-4.5-sonnet, gpt-5.2-codex, ... | Cursor OAuth |
| **GitHub Copilot** | gpt-4.1, gpt-5, claude-sonnet-4.5, gemini-2.5-pro, ... | GitHub OAuth |

Routing is automatic based on the model name prefix:
- `cu/` hoặc `cursor/` → Cursor
- `gh/` hoặc `github/` → GitHub Copilot
- `claude-*` → Antigravity
- `gemini-*` → Antigravity
- `gpt-5*` hoặc `*codex*` → Codex

---

## Installation

```bash
git clone https://github.com/quangvan99/ai_proxy.git
cd ai_proxy
npm install
```

---

## Quick Start

### 1. Start the server

```bash
npm start
```

Server chạy tại `http://localhost:8386`.

```bash
# Background (daemon mode)
./start.sh

# Stop
./stop.sh

# Custom port
PORT=3001 npm start

# Debug mode
npm start -- --dev-mode
```

### 2. Add accounts

Thêm ít nhất 1 account cho provider bạn muốn dùng:

```bash
# Google (Antigravity)
npm run accounts:add              # Desktop (mở browser)
npm run accounts:add -- --no-browser  # Headless/SSH

# Codex (OpenAI)
npm run codex:accounts:add

# Cursor
npm run cursor:accounts:add

# GitHub Copilot
npm run github:accounts:add
```

### 3. Configure Claude Code

Sửa file `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386"
  }
}
```

Sau đó chạy `claude` như bình thường.

---

## Model Configuration

Có 2 cách cấu hình: qua `~/.claude/settings.json` hoặc qua biến môi trường (`export`).

### Claude (qua Antigravity)

**settings.json:**
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5-thinking"
  }
}
```

**export:**
```bash
export ANTHROPIC_AUTH_TOKEN="test"
export ANTHROPIC_BASE_URL="http://localhost:8386"
export ANTHROPIC_MODEL="claude-sonnet-4-5-thinking"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5-thinking"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5-thinking"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-sonnet-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5-thinking"
```

### Gemini

**settings.json:**
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386",
    "ANTHROPIC_MODEL": "gemini-3-pro-high",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3-pro-high",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3-flash"
  }
}
```

**export:**
```bash
export ANTHROPIC_AUTH_TOKEN="test"
export ANTHROPIC_BASE_URL="http://localhost:8386"
export ANTHROPIC_MODEL="gemini-3-pro-high"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gemini-3-pro-high"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gemini-3-flash"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gemini-3-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="gemini-3-flash"
```

### Codex (OpenAI)

**settings.json:**
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386",
    "ANTHROPIC_MODEL": "gpt-5.1-codex",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.3-codex",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.3-codex",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.1-codex-mini",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gpt-5.1-codex-mini"
  }
}
```

**export:**
```bash
export ANTHROPIC_AUTH_TOKEN="test"
export ANTHROPIC_BASE_URL="http://localhost:8386"
export ANTHROPIC_MODEL="gpt-5.3-codex"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.3-codex"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.3-codex"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.3-codex"
export CLAUDE_CODE_SUBAGENT_MODEL="gpt-5.3-codex"
```

### GitHub Copilot

**settings.json:**
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8386",
    "ANTHROPIC_MODEL": "gh/claude-sonnet-4.5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gh/claude-opus-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gh/claude-sonnet-4.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gh/claude-haiku-4.5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gh/claude-haiku-4.5"
  }
}
```

**export:**
```bash
export ANTHROPIC_AUTH_TOKEN="test"
export ANTHROPIC_BASE_URL="http://localhost:8386"
export ANTHROPIC_MODEL="gh/claude-sonnet-4.5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gh/claude-opus-4.1"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gh/claude-sonnet-4.5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gh/claude-haiku-4.5"
export CLAUDE_CODE_SUBAGENT_MODEL="gh/claude-haiku-4.5"
```

---

## Account Management

```bash
# Google (Antigravity)
npm run accounts           # Menu tương tác
npm run accounts:list      # Xem danh sách
npm run accounts:verify    # Kiểm tra token
npm run accounts:remove    # Xóa account

# Codex
npm run codex:accounts     # Menu tương tác
npm run codex:accounts:list
npm run codex:accounts:remove
npm run codex:accounts:clear

# Cursor
npm run cursor:accounts    # Menu tương tác
npm run cursor:accounts:list
npm run cursor:accounts:remove
npm run cursor:accounts:clear

# GitHub Copilot
npm run github:accounts    # Menu tương tác
npm run github:accounts:list
npm run github:accounts:remove
npm run github:accounts:clear
```

---

## API Endpoints

| Endpoint | Mô tả |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (streaming + non-streaming) |
| `GET /v1/models` | Danh sách models |
| `GET /health` | Health check + trạng thái account pool |
| `GET /account-limits` | Chi tiết quota và rate limit |
| `POST /refresh-token` | Force refresh token |

```bash
# Health check
curl http://localhost:8386/health

# Account status (dạng bảng)
curl "http://localhost:8386/account-limits?format=table"
```

---

## So sánh với các repo khác

| Tiêu chí | antigravity-claude-proxy | 9router | ai_proxy (repo này) |
|---|---|---|---|
| Tích hợp Claude Code | Có | Không | Có |
| Hỗ trợ mô hình | Antigravity(Claude/Gemini) | All | All |
| Tool support (WebSearch, Bash) | Có | Không | Có |


---

## License

MIT
