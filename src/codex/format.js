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
        result.tools = tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }));
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
    const text = extractResponseText(response);
    const usage = response?.usage || {};

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: text || '' }],
        model: model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        }
    };
}

function extractResponseText(response) {
    if (!response) return '';
    if (typeof response.output_text === 'string') return response.output_text;

    const output = response.output || response.response?.output || [];
    const texts = [];
    for (const item of output) {
        if (!item) continue;
        const content = item.content || [];
        for (const part of content) {
            if (part.type === 'output_text' || part.type === 'text') {
                if (part.text) texts.push(part.text);
            }
        }
    }
    return texts.join('');
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

            if (eventType === 'response.completed') {
                const u = data.usage || chunk.usage || {};
                usage = {
                    input_tokens: u.input_tokens || usage.input_tokens || 0,
                    output_tokens: u.output_tokens || usage.output_tokens || 0
                };
            }
        }
    }

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: textParts.join('') }],
        model: model,
        stop_reason: 'end_turn',
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
    let blockIndex = 0;
    let outputTokens = 0;
    let inputTokens = 0;
    let stopReason = 'end_turn';

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

                    yield {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: { type: 'text', text: '' }
                    };
                }

                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: delta }
                };
            }

            if (eventType === 'response.completed') {
                const usage = chunk.response?.usage || chunk.data?.usage || chunk.usage || {};
                inputTokens = usage.input_tokens || inputTokens;
                outputTokens = usage.output_tokens || outputTokens;
            }
        }
    }

    if (!started) {
        throw new Error('No content received from Codex response');
    }

    yield { type: 'content_block_stop', index: blockIndex };
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
