/**
 * GitHub Copilot format converters
 * Anthropic Messages API <-> OpenAI Chat Completions
 */

import crypto from 'crypto';

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

export function normalizeGithubModel(modelName) {
  if (!modelName) return modelName;
  const lower = modelName.toLowerCase();
  if (lower.startsWith('gh/') || lower.startsWith('github/')) {
    return modelName.slice(modelName.indexOf('/') + 1);
  }
  return modelName;
}

export function convertAnthropicToOpenAIRequest(anthropicRequest) {
  const {
    model,
    messages = [],
    system,
    tools,
    tool_choice,
    max_tokens,
    temperature,
    top_p,
    stream
  } = anthropicRequest;

  const outMessages = [];

  if (system) {
    const sysText = Array.isArray(system)
      ? system.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')
      : String(system || '');
    if (sysText) {
      outMessages.push({ role: 'system', content: sysText });
    }
  }

  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;

    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = extractTextBlocks(content).join('');
    }

    const toolCalls = [];
    const toolResults = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
            type: 'function',
            function: {
              name: block.name || 'tool',
              arguments: JSON.stringify(block.input || {})
            }
          });
        } else if (block.type === 'tool_result') {
          toolResults.push({
            tool_call_id: block.tool_use_id || block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
            content: toolResultToOutput(block.content)
          });
        }
      }
    }

    if (role === 'user' || role === 'assistant') {
      const msgObj = { role, content: text || '' };
      if (toolCalls.length > 0) msgObj.tool_calls = toolCalls;
      outMessages.push(msgObj);

      for (const tr of toolResults) {
        outMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_call_id,
          content: tr.content
        });
      }
    }
  }

  const request = {
    model: normalizeGithubModel(model),
    messages: outMessages,
    stream: stream === true
  };

  if (max_tokens) request.max_tokens = max_tokens;
  if (temperature !== undefined) request.temperature = temperature;
  if (top_p !== undefined) request.top_p = top_p;

  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }));
  }

  if (tool_choice) {
    request.tool_choice = tool_choice;
  }

  return request;
}

export function convertOpenAIResponseToAnthropic(response, model) {
  const choice = response?.choices?.[0] || {};
  const message = choice.message || {};
  const contentBlocks = [];

  if (message.content) {
    contentBlocks.push({ type: 'text', text: message.content });
  }

  const toolCalls = message.tool_calls || [];
  for (const tc of toolCalls) {
    let input = {};
    try {
      input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { raw: tc.function?.arguments || '' };
    }
    contentBlocks.push({
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
    content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response?.usage?.prompt_tokens || 0,
      output_tokens: response?.usage?.completion_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  };
}

export async function collectOpenAIStreamToAnthropic(response, model) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const textParts = [];
  const toolCalls = new Map();
  let usage = { input_tokens: 0, output_tokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta || {};
      if (delta.content) textParts.push(delta.content);

      const deltaToolCalls = delta.tool_calls || [];
      for (const tc of deltaToolCalls) {
        const id = tc.id || toolCalls.get(tc.index)?.id || `call_${tc.index || 0}`;
        const existing = toolCalls.get(tc.index) || { id, name: tc.function?.name || '', args: '' };
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        toolCalls.set(tc.index, existing);
      }

      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens || usage.input_tokens,
          output_tokens: chunk.usage.completion_tokens || usage.output_tokens
        };
      }
    }
  }

  const content = [];
  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('') });
  }

  for (const tc of toolCalls.values()) {
    let input = {};
    try {
      input = tc.args ? JSON.parse(tc.args) : {};
    } catch {
      input = { raw: tc.args || '' };
    }
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name || 'tool',
      input
    });
  }

  const stopReason = toolCalls.size > 0 ? 'tool_use' : 'end_turn';

  return {
    id: `msg_${crypto.randomBytes(16).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  };
}

export async function* streamOpenAIResponseToAnthropic(response, model) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
  let started = false;
  let nextIndex = 0;
  let textBlockIndex = null;
  const toolBlocks = new Map(); // index -> { id, name, args, closed }
  let stopReason = 'end_turn';

  const ensureMessageStart = () => {
    if (started) return null;
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const choice = chunk.choices?.[0] || {};
      if (choice.finish_reason) {
        stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
      }

      const delta = choice.delta || {};
      if (delta.content) {
        const startEvent = ensureMessageStart();
        if (startEvent) yield startEvent;
        const textStart = ensureTextBlockStart();
        if (textStart) yield textStart;
        yield {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content }
        };
      }

      const deltaToolCalls = delta.tool_calls || [];
      for (const tc of deltaToolCalls) {
        const startEvent = ensureMessageStart();
        if (startEvent) yield startEvent;

        if (textBlockIndex !== null) {
          yield { type: 'content_block_stop', index: textBlockIndex };
          textBlockIndex = null;
        }

        const idx = tc.index ?? 0;
        let state = toolBlocks.get(idx);
        if (!state || state.closed) {
          const toolId = tc.id || state?.id || `toolu_${crypto.randomBytes(8).toString('hex')}`;
          state = { id: toolId, name: tc.function?.name || '', args: '', index: nextIndex++, closed: false };
          toolBlocks.set(idx, state);
          yield {
            type: 'content_block_start',
            index: state.index,
            content_block: {
              type: 'tool_use',
              id: state.id,
              name: state.name || 'tool',
              input: {}
            }
          };
        }

        if (tc.function?.name) state.name = tc.function.name;
        if (tc.function?.arguments) {
          state.args += tc.function.arguments;
          yield {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
          };
        }
      }
    }
  }

  if (!started) {
    throw new Error('No content received from Copilot response');
  }

  if (textBlockIndex !== null) {
    yield { type: 'content_block_stop', index: textBlockIndex };
  }

  for (const state of toolBlocks.values()) {
    if (!state.closed) {
      state.closed = true;
      yield { type: 'content_block_stop', index: state.index };
    }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: toolBlocks.size > 0 ? 'tool_use' : stopReason, stop_sequence: null },
    usage: {
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  };
  yield { type: 'message_stop' };
}
