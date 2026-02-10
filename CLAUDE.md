# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude models (`claude-sonnet-4-5-thinking`, `claude-opus-4-5-thinking`) and Gemini models (`gemini-3-flash`, `gemini-3-pro-low`, `gemini-3-pro-high`) with Claude Code CLI.

The proxy translates requests from Anthropic Messages API format → Google Generative AI format → Antigravity Cloud Code API, then converts responses back to Anthropic format with full thinking/streaming support.

## Commands

```bash
# Install dependencies
npm install

# Start server (runs on port 8386)
npm start

# Uses Hybrid Strategy (Smart Distribution) by default

# Start with developer mode (debug logging + dev tools)
npm start -- --dev-mode

# Start with debug logging (legacy alias, also enables dev mode)
npm start -- --debug

# Development mode (file watching)
npm run dev

# Account management (CLI only)
npm run accounts         # Interactive account management
npm run accounts:add     # Add a new Google account via OAuth
npm run accounts:add -- --no-browser  # Add account on headless server (manual code input)
npm run accounts:list    # List configured accounts
npm run accounts:verify  # Verify account tokens are valid
```

## Architecture

**Request Flow:**
```
Claude Code CLI → Express Server (server.js) → CloudCode Client → Antigravity Cloud Code API
```

**Directory Structure:**

```
src/
├── index.js                    # Entry point
├── server.js                   # Express server
├── constants.js                # Configuration values
├── errors.js                   # Custom error classes
│
├── cloudcode/                  # Cloud Code API client
│   ├── index.js                # Public API exports
│   ├── session-manager.js      # Session ID derivation for caching
│   ├── rate-limit-parser.js    # Parse reset times from headers/errors
│   ├── request-builder.js      # Build API request payloads
│   ├── sse-parser.js           # Parse SSE for non-streaming
│   ├── sse-streamer.js         # Stream SSE events in real-time
│   ├── message-handler.js      # Non-streaming message handling
│   ├── streaming-handler.js    # Streaming message handling
│   └── model-api.js            # Model listing and quota APIs
│
├── account-manager/            # Multi-account pool management
│   ├── index.js                # AccountManager class facade
│   ├── storage.js              # Config file I/O and persistence
│   ├── rate-limits.js          # Rate limit tracking and state
│   ├── credentials.js          # OAuth token and project handling
│   └── strategies/             # Account selection strategies
│       ├── index.js            # Strategy factory
│       ├── base-strategy.js    # Abstract base class
│       ├── hybrid-strategy.js  # Smart Distribution (only strategy)
│       └── trackers/           # Shared tracking modules
│           ├── health-tracker.js       # Account health scoring
│           ├── quota-tracker.js        # Quota exhaustion detection
│           └── token-bucket-tracker.js # Rate limit tracking
│
├── auth/                       # Authentication and OAuth
│   └── oauth.js                # Google OAuth 2.0 flow
│
├── format/                     # Request/Response conversion
│   ├── index.js                # Public API exports
│   ├── request-converter.js    # Anthropic → Google format
│   ├── response-converter.js   # Google → Anthropic format
│   ├── content-converter.js    # Message content transformation
│   ├── thinking-utils.js       # Thinking block extraction/formatting
│   ├── signature-cache.js      # Thinking signature caching
│   └── schema-sanitizer.js     # Tool schema validation
│
├── cli/                        # Command-line tools
│   └── accounts.js             # Account management CLI
│
└── utils/                      # Shared utilities
    ├── logger.js               # Colored logging
    ├── helpers.js              # General utilities
    ├── proxy.js                # HTTP proxy detection
    └── native-module-helper.js # Native module loading
```

## Core Modules

### 1. Server (src/server.js)
Express server that implements Anthropic-compatible API endpoints:
- `POST /v1/messages` - Message generation (streaming and non-streaming)
- `GET /v1/models` - List available models
- `GET /health` - Health check with account pool status
- `POST /refresh-token` - Force token refresh
- `POST /clear-cache` - Clear signature cache

### 2. CloudCode Client (src/cloudcode/)
Handles all communication with Antigravity's Cloud Code API:
- Request building with proper headers and authentication
- SSE streaming parser for real-time responses
- Rate limit detection and parsing
- Model listing and quota queries

### 3. Account Manager (src/account-manager/)
Manages multiple Google accounts for load balancing:
Uses **Hybrid Strategy (Smart Distribution)** for intelligent account selection:
- Health-based scoring (success/failure tracking)
- Token bucket rate limiting
- Quota-aware selection
- LRU (Least Recently Used) balancing

Tracks:
- Account health scores (success/failure rates)
- Quota exhaustion per model
- Rate limits and reset times
- Token bucket for request rate limiting

### 4. Format Converters (src/format/)
Bidirectional conversion between API formats:
- Anthropic Messages API ↔ Google Generative AI
- Thinking block extraction and signature generation
- Tool/function calling schema translation
- Prompt caching support

### 5. Authentication (src/auth/)
- Extract tokens from Antigravity's local SQLite database
- OAuth 2.0 flow for adding accounts manually
- Token refresh and project ID management

## API Endpoints

### Messages API
- `POST /v1/messages` - Send a message (streaming or non-streaming)
  - Headers: `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01`
  - Body: Standard Anthropic Messages API format
  - Query params: `?stream=true` for streaming

### Model API
- `GET /v1/models` - List available models
- `GET /health` - Server health and account status
  - Returns: `{ status, accounts, models, globalQuotaThreshold }`
  - Query params: `?format=table` (ASCII table) or `?includeHistory=true` (usage stats)

## Account Management

All account management is done via CLI commands:

```bash
# Interactive menu
npm run accounts

# Add account via OAuth
npm run accounts:add

# Add account on headless server (manual code input)
npm run accounts:add -- --no-browser

# List all accounts with status
npm run accounts:list

# Verify account tokens are valid
npm run accounts:verify

# Remove account (interactive)
npm run accounts:remove
```

Account data is stored in `~/.antigravity-accounts.json`.

## Configuration

Server configuration is managed via environment variables or `~/.antigravity-proxy.json`:
- `PORT` - Server port (default: 8386)
- `API_KEY` - Optional API key for authentication
- `DEV_MODE` - Enable debug logging and dev tools

## Maintenance

When making significant changes to the codebase (new modules, refactoring, architectural changes), update this CLAUDE.md and the README.md file to keep documentation in sync.
