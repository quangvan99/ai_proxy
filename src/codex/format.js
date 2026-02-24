/**
 * Codex format converters
 * Anthropic Messages API <-> OpenAI Responses API
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

/**
 * Convert Anthropic request to OpenAI Responses API format
 * @param {Object} anthropicRequest
 * @returns {Object}
 */
export function convertAnthropicToCodexRequest(anthropicRequest) {
    const {
        model,
        messages = [],
        system,
        tools,
        tool_choice
    } = anthropicRequest;

    const result = {
        model,
        input: [],
        stream: anthropicRequest.stream !== false,
        store: false
    };

    // System -> instructions
    if (system) {
        if (typeof system === 'string') {
            result.instructions = system;
        } else if (Array.isArray(system)) {
            const sysText = system
                .filter(b => b && b.type === 'text')
                .map(b => b.text)
                .join('\n');
            result.instructions = sysText;
        }
    }

    if (!result.instructions) {
        result.instructions = '';
    }

    for (const msg of messages) {
        const role = msg.role;
        const content = msg.content;

        if (role === 'user' || role === 'assistant') {
            const parts = [];
            const textParts = extractTextBlocks(content);
            for (const text of textParts) {
                if (!text) continue;
                parts.push({
                    type: role === 'user' ? 'input_text' : 'output_text',
                    text
                });
            }

            if (parts.length > 0) {
                result.input.push({
                    type: 'message',
                    role,
                    content: parts
                });
            }
        }

        if (Array.isArray(content)) {
            for (const block of content) {
                if (!block) continue;
                if (block.type === 'tool_use') {
                    result.input.push({
                        type: 'function_call',
                        call_id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                        name: block.name || '',
                        arguments: JSON.stringify(block.input || {})
                    });
                } else if (block.type === 'tool_result') {
                    result.input.push({
                        type: 'function_call_output',
                        call_id: block.tool_use_id || block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                        output: toolResultToOutput(block.content)
                    });
                }
            }
        }
    }

    if (Array.isArray(tools) && tools.length > 0) {
        const hasWebSearch = tools.some(t => t.name === 'WebSearch' || t.name === 'web_search');
        const otherTools = tools.filter(t => t.name !== 'WebSearch' && t.name !== 'web_search');

        result.tools = [];

        // Inject Codex native web_search instead of function-based WebSearch
        if (hasWebSearch) {
            result.tools.push({ type: 'web_search' });
        }

        // Convert remaining function tools normally
        for (const t of otherTools) {
            result.tools.push({
                type: 'function',
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            });
        }
    }

    if (tool_choice) {
        result.tool_choice = tool_choice;
    }

    return result;
}

/**
 * Convert OpenAI Responses API response to Anthropic Messages API response
 * @param {Object} response
 * @param {string} model
 * @returns {Object}
 */
export function convertCodexResponseToAnthropic(response, model) {
    const usage = response?.usage || {};
    const content = extractResponseContent(response);

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content,
        model: model,
        stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        }
    };
}

function extractResponseContent(response) {
    if (!response) return [{ type: 'text', text: '' }];

    const output = response.output || response.response?.output || [];
    const blocks = [];

    for (const item of output) {
        if (!item) continue;

        // function_call items at top level (OpenAI Responses API)
        if (item.type === 'function_call') {
            let input = {};
            try { input = JSON.parse(item.arguments || '{}'); } catch { input = {}; }
            blocks.push({
                type: 'tool_use',
                id: item.call_id || item.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                name: item.name || '',
                input
            });
            continue;
        }

        const content = item.content || [];
        for (const part of content) {
            if (!part) continue;
            if (part.type === 'output_text' || part.type === 'text') {
                if (part.text) blocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'function_call') {
                let input = {};
                try { input = JSON.parse(part.arguments || '{}'); } catch { input = {}; }
                blocks.push({
                    type: 'tool_use',
                    id: part.call_id || part.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                    name: part.name || '',
                    input
                });
            }
        }
    }

    if (blocks.length === 0) {
        if (typeof response.output_text === 'string') {
            return [{ type: 'text', text: response.output_text }];
        }
        return [{ type: 'text', text: '' }];
    }

    return blocks;
}

function extractResponseText(response) {
    const blocks = extractResponseContent(response);
    return blocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
}

/**
 * Collect a streaming Responses API SSE into a single Anthropic response
 * @param {Response} response
 * @param {string} model
 * @returns {Promise<Object>}
 */
export async function collectCodexStreamToAnthropicResponse(response, model) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const textParts = [];
    // Map call_id -> { name, argumentParts[] }
    const toolCalls = {};
    const toolCallOrder = [];
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

            const eventType = chunk.type || chunk.event;
            const data = chunk.data || chunk;

            if (eventType === 'response.output_text.delta') {
                const delta = data.delta || '';
                if (delta) textParts.push(delta);
            }

            if (eventType === 'response.output_item.added') {
                const item = data.item || chunk.item;
                if (item && item.type === 'function_call') {
                    const callId = item.call_id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
                    const itemId = item.id || callId;
                    toolCalls[itemId] = { callId, name: item.name || '', argumentParts: [] };
                    toolCallOrder.push(itemId);
                }
            }

            if (eventType === 'response.function_call_arguments.delta') {
                const itemId = data.item_id || chunk.item_id;
                const delta = data.delta || chunk.delta || '';
                if (itemId && toolCalls[itemId]) {
                    toolCalls[itemId].argumentParts.push(delta);
                }
            }

            if (eventType === 'response.function_call_arguments.done') {
                const itemId = data.item_id || chunk.item_id;
                const args = data.arguments || chunk.arguments;
                if (itemId && toolCalls[itemId] && args != null) {
                    toolCalls[itemId].argumentParts = [args];
                }
            }

            if (eventType === 'response.completed') {
                const u = data.usage || chunk.usage || {};
                usage = {
                    input_tokens: u.input_tokens || usage.input_tokens || 0,
                    output_tokens: u.output_tokens || usage.output_tokens || 0
                };
            }
        }
    }

    const content = [];
    const textContent = textParts.join('');
    if (textContent) content.push({ type: 'text', text: textContent });

    for (const itemId of toolCallOrder) {
        const tc = toolCalls[itemId];
        let input = {};
        try { input = JSON.parse(tc.argumentParts.join('')); } catch { input = {}; }
        content.push({
            type: 'tool_use',
            id: tc.callId,
            name: tc.name,
            input
        });
    }

    if (content.length === 0) content.push({ type: 'text', text: '' });

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content,
        model: model,
        stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        }
    };
}

/**
 * Stream OpenAI Responses SSE into Anthropic SSE events
 * @param {Response} response
 * @param {string} model
 */
export async function* streamCodexResponseToAnthropic(response, model) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let started = false;
    let textBlockIndex = null;
    let currentToolItemId = null;
    // item_id -> { callId, blockIndex }
    const toolBlockMap = {};
    let nextIndex = 0;
    let outputTokens = 0;
    let inputTokens = 0;
    let hasToolUse = false;

    const ensureStarted = function* () {
        if (!started) {
            started = true;
            yield {
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
                        input_tokens: inputTokens,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0
                    }
                }
            };
        }
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

            const eventType = chunk.type || chunk.event;

            if (eventType === 'response.output_text.delta') {
                const delta = chunk.delta || chunk.data?.delta || '';
                if (!delta) continue;

                yield* ensureStarted();

                if (textBlockIndex === null) {
                    textBlockIndex = nextIndex++;
                    yield {
                        type: 'content_block_start',
                        index: textBlockIndex,
                        content_block: { type: 'text', text: '' }
                    };
                }

                yield {
                    type: 'content_block_delta',
                    index: textBlockIndex,
                    delta: { type: 'text_delta', text: delta }
                };
            }

            if (eventType === 'response.output_item.added') {
                const item = chunk.item || chunk.data?.item;
                if (item && item.type === 'function_call') {
                    yield* ensureStarted();

                    // Close text block first if open
                    if (textBlockIndex !== null) {
                        yield { type: 'content_block_stop', index: textBlockIndex };
                        textBlockIndex = null;
                    }

                    const callId = item.call_id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
                    const itemId = item.id || callId;
                    const blockIndex = nextIndex++;
                    toolBlockMap[itemId] = { callId, blockIndex };
                    currentToolItemId = itemId;
                    hasToolUse = true;

                    yield {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: {
                            type: 'tool_use',
                            id: callId,
                            name: item.name || '',
                            input: {}
                        }
                    };
                }
            }

            if (eventType === 'response.function_call_arguments.delta') {
                const itemId = chunk.item_id || chunk.data?.item_id;
                const delta = chunk.delta || chunk.data?.delta || '';
                if (!delta) continue;

                const entry = itemId ? toolBlockMap[itemId] : (currentToolItemId ? toolBlockMap[currentToolItemId] : null);
                if (!entry) {
                    // fallback: emit to last known tool block
                    const lastItemId = currentToolItemId || Object.keys(toolBlockMap).pop();
                    if (lastItemId && toolBlockMap[lastItemId]) {
                        yield {
                            type: 'content_block_delta',
                            index: toolBlockMap[lastItemId].blockIndex,
                            delta: { type: 'input_json_delta', partial_json: delta }
                        };
                    }
                    continue;
                }

                yield {
                    type: 'content_block_delta',
                    index: entry.blockIndex,
                    delta: { type: 'input_json_delta', partial_json: delta }
                };
            }

            if (eventType === 'response.output_item.done') {
                // Don't close block here - wait until response.completed or next item opens
                // This avoids closing before all delta events arrive
            }

            if (eventType === 'response.completed') {
                const usage = chunk.response?.usage || chunk.data?.usage || chunk.usage || {};
                inputTokens = usage.input_tokens || inputTokens;
                outputTokens = usage.output_tokens || outputTokens;
            }
        }
    }

    if (!started) {
        // Emit empty message if nothing was received
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
            }
        };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_stop', index: 0 };
    } else {
        // Close any still-open text block
        if (textBlockIndex !== null) {
            yield { type: 'content_block_stop', index: textBlockIndex };
        }
        // Close any still-open tool block
        if (currentToolItemId !== null && toolBlockMap[currentToolItemId]) {
            yield { type: 'content_block_stop', index: toolBlockMap[currentToolItemId].blockIndex };
        }
    }

    const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        }
    };
    yield { type: 'message_stop' };
}
