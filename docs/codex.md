# Codex Proxy - Cách hoạt động

Proxy chuyển đổi **Anthropic Messages API** ↔ **OpenAI Responses API** để Claude Code CLI có thể dùng model Codex (`gpt-5.1-codex`, `o4-mini`, ...) như thể đang dùng Claude.

---

## Tổng quan luồng xử lý

```
Claude Code CLI
      │  POST /v1/messages (Anthropic format)
      ▼
  Proxy (server.js)
      │  nhận diện modelFamily = 'codex'
      │  convertAnthropicToCodexRequest()
      ▼
  ChatGPT Responses API
  https://chatgpt.com/backend-api/codex/responses
      │  SSE stream (OpenAI format)
      ▼
  Proxy
      │  streamCodexResponseToAnthropic() hoặc collectCodexStreamToAnthropicResponse()
      ▼
Claude Code CLI (Anthropic SSE format)
```

---

## Chi tiết từng bước

### 1. Nhận request từ CLI (`server.js`)

CLI gửi request Anthropic format:
```json
{
  "model": "gpt-5.1-codex",
  "messages": [...],
  "tools": [...],
  "stream": true
}
```

`server.js` phát hiện `modelFamily === 'codex'` rồi route sang `sendCodexMessageStream()` hoặc `sendCodexMessage()`.

---

### 2. Chọn account (`account-manager.js`)

`CodexAccountManager` quản lý pool accounts trong `codex-accounts.json`:
- **Round-robin** qua các accounts available
- Bỏ qua account đang bị `cooldownUntil` (rate limited)
- Bỏ qua account `isInvalid`
- Nếu tất cả đều rate limited → trả `waitMs` để caller chờ

**Auto refresh token:**
Nếu `accessToken` sắp hết hạn (trong vòng 5 phút), tự động dùng `refreshToken` để lấy token mới qua OAuth token endpoint trước khi gửi request.

---

### 3. Convert request (`format.js` - `convertAnthropicToCodexRequest`)

| Anthropic | OpenAI Responses API |
|-----------|---------------------|
| `messages[].role = "user"` content text | `input[].type = "message"` với `input_text` |
| `messages[].role = "assistant"` content text | `input[].type = "message"` với `output_text` |
| `content[].type = "tool_use"` | `input[].type = "function_call"` |
| `content[].type = "tool_result"` | `input[].type = "function_call_output"` |
| `system` (string/array) | `instructions` (string) |
| `tools[].input_schema` | `tools[].parameters` |

**Đặc biệt - WebSearch:**
CLI inject tool `WebSearch` như function tool thông thường. Nhưng Codex có built-in web search thực sự.

```js
// Thay vì convert WebSearch thành function tool (Codex không tự thực thi được):
{ type: 'function', name: 'WebSearch', ... }

// Proxy inject native tool của OpenAI Responses API:
{ type: 'web_search' }
```

Kết quả: Codex tự search web, trả kết quả trực tiếp trong response - không cần round-trip `tool_result` từ CLI.

---

### 4. Gọi Codex API (`handlers.js`)

**Non-streaming** (`sendCodexMessage`):
Codex endpoint bắt buộc `stream: true`, nên proxy luôn gọi stream rồi dùng `collectCodexStreamToAnthropicResponse()` để gom lại thành 1 response.

**Streaming** (`sendCodexMessageStream`):
Gọi Codex với `stream: true`, pipe trực tiếp qua `streamCodexResponseToAnthropic()`.

**Retry logic:**
- `maxAttempts = max(3, accountCount + 1)`
- 401/403 → `markInvalid()`, thử account khác
- 429 → đọc `Retry-After` header, `markRateLimited()`, thử account khác

---

### 5. Convert response (`format.js`)

#### Non-streaming (`collectCodexStreamToAnthropicResponse`)

Đọc hết SSE stream từ Codex, gom các events:

| Codex event | Xử lý |
|-------------|-------|
| `response.output_text.delta` | Gom text vào `textParts[]` |
| `response.output_item.added` (function_call) | Tạo entry trong `toolCalls{}` |
| `response.function_call_arguments.delta` | Gom JSON arguments |
| `response.function_call_arguments.done` | Finalize arguments |
| `response.completed` | Lấy usage tokens |

Kết quả trả về Anthropic format với `content[]` chứa `text` và/hoặc `tool_use` blocks.

#### Streaming (`streamCodexResponseToAnthropic`)

Convert từng Codex SSE event thành Anthropic SSE events theo thứ tự:

```
message_start
  content_block_start (text)
    content_block_delta (text_delta) × N
  content_block_stop
  content_block_start (tool_use)
    content_block_delta (input_json_delta) × N
  content_block_stop
message_delta (stop_reason)
message_stop
```

**stop_reason:**
- Có ít nhất 1 `tool_use` block → `"tool_use"`
- Không có → `"end_turn"`

---

### 6. OAuth (`oauth.js`)

Dùng **PKCE flow** để đăng nhập tài khoản ChatGPT:

```
1. getCodexAuthorizationUrl()  → tạo URL + code_verifier (PKCE)
2. User mở browser, đăng nhập ChatGPT
3. startCodexCallbackServer()  → lắng nghe redirect trên localhost:PORT
4. exchangeCodeForTokens()     → đổi code lấy access_token + refresh_token
5. Lưu vào codex-accounts.json
```

Sau đó `refreshCodexToken()` tự động làm mới khi token sắp hết hạn.

---

## Cấu hình

### Thêm account Codex

```bash
npm run codex:add
# hoặc
node src/cli/codex-accounts.js add
```

### File lưu trữ

`codex-accounts.json` (nằm ngoài git):
```json
{
  "accounts": [
    {
      "id": "user@gmail.com",
      "email": "user@gmail.com",
      "refreshToken": "...",
      "accessToken": "...",
      "expiresAt": "2026-03-01T00:00:00.000Z",
      "enabled": true,
      "isInvalid": false,
      "cooldownUntil": null
    }
  ]
}
```

### Models

Danh sách models Codex được khai báo trong `config.example.json` → `codexModels[]`. Proxy nhận diện qua `isValidCodexModel()`.

---

## Điểm khác biệt so với Anthropic/Gemini

| | Anthropic | Gemini | Codex |
|--|-----------|--------|-------|
| API format | Messages API | Messages API (qua proxy Antigravity) | Responses API |
| Streaming | SSE `event: ...` | SSE `event: ...` | SSE `data: {...type...}` |
| Tool execution | Server-side (WebSearch, bash...) | Client-side | Built-in (`web_search`, `code_interpreter`) |
| Auth | API key | OAuth (Google) | OAuth (OpenAI/ChatGPT) |
| Thinking | `thinking` blocks | `thoughtSignature` field | `reasoning` items trong output |
