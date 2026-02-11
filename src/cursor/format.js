/**
 * Cursor format converters
 * Anthropic Messages API <-> Cursor protobuf format
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { generateCursorBody, extractTextFromResponse } from './cursorProtobuf.js';

function extractTextBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [String(content || '')];

  const texts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts;
}

function toolResultToOutput(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(c => c && c.type === 'text')
      .map(c => c.text || '')
      .join('\n');
    return texts || JSON.stringify(content);
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

export function normalizeCursorModel(modelName) {
  if (!modelName) return modelName;
  const lower = modelName.toLowerCase();
  if (lower.startsWith('cu/') || lower.startsWith('cursor/')) {
    return modelName.slice(modelName.indexOf('/') + 1);
  }
  return modelName;
}

/**
 * Convert Anthropic request to Cursor protobuf input
 */
export function convertAnthropicToCursorRequest(anthropicRequest) {
  const { model, messages = [], system, tools, thinking } = anthropicRequest;

  const cursorMessages = [];
  let pendingToolResults = [];

  if (system) {
    const sysText = Array.isArray(system)
      ? system.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')
      : String(system || '');

    if (sysText) {
      cursorMessages.push({
        role: 'user',
        content: `[System Instructions]\n${sysText}`
      });
    }
  }

  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;

    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const textParts = extractTextBlocks(content);
      text = textParts.join('');
    }

    let toolCalls = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'tool_result') {
          pendingToolResults.push({
            tool_call_id: block.tool_use_id || block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
            name: block.name || 'tool',
            index: pendingToolResults.length,
            raw_args: toolResultToOutput(block.content)
          });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
            type: 'function',
            function: {
              name: block.name || 'tool',
              arguments: JSON.stringify(block.input || {})
            }
          });
        }
      }
    }

    if (role === 'user' || role === 'assistant') {
      if (text || pendingToolResults.length > 0 || toolCalls.length > 0) {
        const msgObj = {
          role,
          content: text || ''
        };
        if (toolCalls.length > 0) msgObj.tool_calls = toolCalls;
        if (pendingToolResults.length > 0) {
          msgObj.tool_results = pendingToolResults;
          pendingToolResults = [];
        }
        cursorMessages.push(msgObj);
      }
    }
  }

  const cursorTools = Array.isArray(tools)
    ? tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      }))
    : [];

  const reasoningEffort = thinking?.reasoning_effort || null;

  return {
    model: normalizeCursorModel(model),
    messages: cursorMessages,
    tools: cursorTools,
    reasoningEffort
  };
}

export function buildCursorBodyFromAnthropic(anthropicRequest) {
  const { model, messages, tools, reasoningEffort } = convertAnthropicToCursorRequest(anthropicRequest);
  return {
    model,
    originalModel: anthropicRequest.model,
    body: generateCursorBody(messages, model, tools, reasoningEffort)
  };
}

// ==================== Response parsing ====================

const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: 0x01,
  GZIP_ALT: 0x02,
  GZIP_BOTH: 0x03
};

function decompressPayload(payload, flags) {
  if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
    try {
      const text = payload.toString('utf-8');
      if (text.startsWith('{"error"')) {
        return payload;
      }
    } catch {}
  }

  if (flags === COMPRESS_FLAG.GZIP || flags === COMPRESS_FLAG.GZIP_ALT || flags === COMPRESS_FLAG.GZIP_BOTH) {
    try {
      return Buffer.from(new Uint8Array(zlib.gunzipSync(payload)));
    } catch {
      return payload;
    }
  }
  return payload;
}

function parseJsonError(payload) {
  try {
    const text = payload.toString('utf-8');
    if (text.startsWith('{') && text.includes('"error"')) {
      return JSON.parse(text);
    }
  } catch {}
  return null;
}

export function parseCursorResponseBuffer(buffer) {
  let offset = 0;
  const results = [];

  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) break;
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) break;

    let payload = buffer.slice(offset + 5, offset + 5 + length);
    offset += 5 + length;

    payload = decompressPayload(payload, flags);

    const jsonError = parseJsonError(payload);
    if (jsonError) {
      const msg = jsonError?.error?.message || jsonError?.error?.details?.[0]?.debug?.details?.title || 'Cursor API error';
      const err = new Error(msg);
      err.statusCode = 400;
      throw err;
    }

    const result = extractTextFromResponse(new Uint8Array(payload));
    if (result?.error) {
      const err = new Error(result.error);
      err.statusCode = 429;
      throw err;
    }
    results.push(result);
  }

  return results;
}

export function buildAnthropicResponseFromCursor(buffer, model) {
  const results = parseCursorResponseBuffer(buffer);
  const textParts = [];
  const toolCalls = [];

  for (const r of results) {
    if (r?.text) textParts.push(r.text);
    if (r?.toolCall) toolCalls.push(r.toolCall);
  }

  const content = [];
  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('') });
  }

  for (const tc of toolCalls) {
    let input = {};
    try {
      input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { raw: tc.function?.arguments || '' };
    }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${crypto.randomBytes(8).toString('hex')}`,
      name: tc.function?.name || 'tool',
      input
    });
  }

  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

  return {
    id: `msg_${crypto.randomBytes(16).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  };
}

export async function* streamCursorResponseToAnthropic(buffer, model) {
  const results = parseCursorResponseBuffer(buffer);

  const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
  let started = false;
  let nextIndex = 0;
  let textBlockIndex = null;
  let sawToolCall = false;
  const toolBlocks = new Map(); // id -> { index, closed }

  const ensureMessageStart = () => {
    if (started) return;
    started = true;
    return {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    };
  };

  const ensureTextBlockStart = () => {
    if (textBlockIndex !== null) return null;
    textBlockIndex = nextIndex++;
    return {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' }
    };
  };

  for (const result of results) {
    if (result?.toolCall) {
      sawToolCall = true;
      const startEvent = ensureMessageStart();
      if (startEvent) yield startEvent;

      if (textBlockIndex !== null) {
        yield { type: 'content_block_stop', index: textBlockIndex };
        textBlockIndex = null;
      }

      const tc = result.toolCall;
      let block = toolBlocks.get(tc.id);
      if (!block || block.closed) {
        const index = nextIndex++;
        block = { index, closed: false };
        toolBlocks.set(tc.id, block);
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || 'tool',
            input: {}
          }
        };
      }

      const args = tc.function?.arguments || '';
      if (args) {
        yield {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: args }
        };
      }

      if (tc.isLast && !block.closed) {
        block.closed = true;
        yield { type: 'content_block_stop', index: block.index };
      }
      continue;
    }

    if (!result?.text) continue;

    const startEvent = ensureMessageStart();
    if (startEvent) yield startEvent;
    for (const block of toolBlocks.values()) {
      if (!block.closed) {
        block.closed = true;
        yield { type: 'content_block_stop', index: block.index };
      }
    }
    const textStart = ensureTextBlockStart();
    if (textStart) yield textStart;

    yield {
      type: 'content_block_delta',
      index: textBlockIndex,
      delta: { type: 'text_delta', text: result.text }
    };
  }

  if (!started) {
    throw new Error('No content received from Cursor response');
  }

  if (textBlockIndex !== null) {
    yield { type: 'content_block_stop', index: textBlockIndex };
  }

  for (const block of toolBlocks.values()) {
    if (!block.closed) {
      yield { type: 'content_block_stop', index: block.index };
    }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: sawToolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: {
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  };
  yield { type: 'message_stop' };
}
