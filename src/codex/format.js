/**
 * Codex format converters
 * Anthropic Messages API <-> OpenAI Responses API
 */

import crypto from 'crypto';

/**
 * Strip cache_control fields from all message content blocks.
 * Claude Code CLI sends cache_control on content blocks, but OpenAI Responses API
 * rejects them. Must be called before any other processing.
 */
function cleanCacheControl(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(msg => {
        if (!msg || typeof msg.content === 'string') return msg;
        if (!Array.isArray(msg.content)) return msg;
        return {
            ...msg,
            content: msg.content.map(block => {
                if (!block || !block.cache_control) return block;
                const { cache_control, ...rest } = block;
                return rest;
            })
        };
    });
}

/**
 * Sanitize JSON Schema for OpenAI Responses API compatibility.
 * Strips unsupported keywords, flattens type arrays, resolves $refs.
 */
function sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: { reason: { type: 'string', description: 'Reason for calling this tool' } }, required: ['reason'] };
    }

    // Handle array types: ["string", "null"] -> "string"
    if (Array.isArray(schema)) return schema.map(sanitizeSchema);

    let result = { ...schema };

    // Flatten type arrays: { type: ["string", "null"] } -> { type: "string" }
    if (Array.isArray(result.type)) {
        const nonNull = result.type.filter(t => t !== 'null');
        result.type = nonNull.length > 0 ? nonNull[0] : 'string';
    }

    // Convert $ref to plain object hint
    if (result.$ref) {
        const name = String(result.$ref).split('/').pop() || 'object';
        return { type: 'object', description: result.description ? `${result.description} (See: ${name})` : `See: ${name}` };
    }

    // Merge allOf into flat schema
    if (Array.isArray(result.allOf) && result.allOf.length > 0) {
        const merged = { properties: {}, required: [] };
        for (const sub of result.allOf) {
            if (!sub || typeof sub !== 'object') continue;
            if (sub.properties) Object.assign(merged.properties, sub.properties);
            if (Array.isArray(sub.required)) merged.required.push(...sub.required);
            for (const [k, v] of Object.entries(sub)) {
                if (k !== 'properties' && k !== 'required' && !(k in merged)) merged[k] = v;
            }
        }
        delete result.allOf;
        if (Object.keys(merged.properties).length > 0) result.properties = { ...merged.properties, ...(result.properties || {}) };
        if (merged.required.length > 0) result.required = [...new Set([...merged.required, ...(result.required || [])])];
    }

    // Flatten anyOf/oneOf: pick best option
    for (const key of ['anyOf', 'oneOf']) {
        if (Array.isArray(result[key]) && result[key].length > 0) {
            const opts = result[key].filter(o => o && typeof o === 'object');
            const best = opts.reduce((a, b) => {
                const score = o => (o.type === 'object' || o.properties) ? 3 : (o.type === 'array' || o.items) ? 2 : (o.type && o.type !== 'null') ? 1 : 0;
                return score(a) >= score(b) ? a : b;
            }, opts[0]);
            delete result[key];
            if (best) {
                for (const [k, v] of Object.entries(best)) {
                    if (!(k in result) || k === 'type' || k === 'properties' || k === 'items') result[k] = v;
                }
            }
        }
    }

    // Strip unsupported keywords
    const STRIP = ['additionalProperties', 'default', '$schema', '$defs', 'definitions',
        '$ref', '$id', '$comment', 'minLength', 'maxLength', 'pattern', 'format',
        'minItems', 'maxItems', 'examples', 'allOf', 'anyOf', 'oneOf', 'const'];
    for (const k of STRIP) delete result[k];

    // Recursively sanitize nested schemas
    if (result.properties && typeof result.properties === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(result.properties)) cleaned[k] = sanitizeSchema(v);
        result.properties = cleaned;
    }
    if (result.items) {
        result.items = Array.isArray(result.items) ? result.items.map(sanitizeSchema) : sanitizeSchema(result.items);
    }

    // Validate required array only references existing properties
    if (Array.isArray(result.required) && result.properties) {
        const defined = new Set(Object.keys(result.properties));
        result.required = result.required.filter(p => defined.has(p));
        if (result.required.length === 0) delete result.required;
    }

    return result;
}

/**
 * OpenAI function tools require top-level parameters to be an object schema.
 * Some MCP tools expose empty schemas (`{}`), which must be normalized.
 */
function normalizeFunctionParameters(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }

    const result = { ...schema };

    // Keep compatibility for non-object top-level schemas by wrapping them.
    if (result.type && result.type !== 'object') {
        return {
            type: 'object',
            properties: {
                input: result
            },
            required: ['input']
        };
    }

    if (!result.type) result.type = 'object';

    if (!result.properties || typeof result.properties !== 'object' || Array.isArray(result.properties)) {
        result.properties = {};
    }

    if (Array.isArray(result.required)) {
        const allowed = new Set(Object.keys(result.properties));
        result.required = result.required.filter(key => allowed.has(key));
        if (result.required.length === 0) delete result.required;
    }

    return result;
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
        system,
        tools,
        tool_choice
    } = anthropicRequest;

    // [CRITICAL] Strip cache_control from all messages before processing
    const messages = cleanCacheControl(anthropicRequest.messages || []);

    const result = {
        model,
        input: [],
        stream: anthropicRequest.stream !== false,
        store: false
    };

    // System -> instructions
    const CODEX_AGENT_PREFIX = `You are an autonomous coding agent running inside an agentic loop with full tool use enabled. Tools provided to you are REAL and will be executed — their results will be returned to you in subsequent turns. You MUST use tools to accomplish tasks; do not describe or simulate tool usage in text. When you need to read a file, call the tool. When you need to run a command, call the tool. When you need to search, call the tool. Never say "I would", "I will", "shall I proceed", "do you want me to", "should I", or ask any clarifying questions before acting. Never explain what you are about to do — just call the appropriate tool and do it. If multiple steps are needed, call one tool at a time and continue after receiving the result. Write complete, working code. If you encounter an error, fix it and continue autonomously.

IMPORTANT: For simple conversational messages (greetings, short questions that don't require files or commands), respond directly with text — do NOT spawn Task agents or call tools unnecessarily. Only use tools when actually needed to complete the task.`;

    if (system) {
        if (typeof system === 'string') {
            result.instructions = CODEX_AGENT_PREFIX + '\n\n' + system;
        } else if (Array.isArray(system)) {
            const sysText = system
                .filter(b => b && b.type === 'text')
                .map(b => b.text)
                .join('\n');
            result.instructions = CODEX_AGENT_PREFIX + '\n\n' + sysText;
        }
    }

    if (!result.instructions) {
        result.instructions = CODEX_AGENT_PREFIX;
    }

    // Pre-scan messages to collect all WebSearch tool_use IDs
    // so we can skip their corresponding tool_result blocks
    const webSearchToolUseIds = new Set();
    for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block && block.type === 'tool_use' &&
                (block.name === 'WebSearch' || block.name === 'web_search')) {
                webSearchToolUseIds.add(block.id);
            }
        }
    }

    for (const msg of messages) {
        const role = msg.role;
        const content = msg.content;

        // Check if this message contains tool_use or tool_result blocks
        const hasToolBlocks = Array.isArray(content) && content.some(
            b => b && (b.type === 'tool_use' || b.type === 'tool_result')
        );

        if (role === 'user' || role === 'assistant') {
            // Only emit a text message if there are actual text parts
            // (skip if the message is purely tool_use/tool_result)
            const parts = [];
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block) continue;
                    if (block.type === 'text' && block.text) {
                        parts.push({
                            type: role === 'user' ? 'input_text' : 'output_text',
                            text: block.text
                        });
                    }
                    // thinking blocks: skip (not supported by OpenAI Responses API)
                }
            } else if (typeof content === 'string' && content) {
                parts.push({
                    type: role === 'user' ? 'input_text' : 'output_text',
                    text: content
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

        // Emit tool_use as function_call and tool_result as function_call_output
        // WebSearch tool_use/tool_result are skipped: Codex uses native web_search
        // which has no round-trip, so these blocks have no equivalent in Codex history.
        if (hasToolBlocks) {
            for (const block of content) {
                if (!block) continue;
                if (block.type === 'tool_use') {
                    // Skip WebSearch — Codex handles it natively, no function_call needed
                    if (block.name === 'WebSearch' || block.name === 'web_search') continue;
                    result.input.push({
                        type: 'function_call',
                        call_id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                        name: block.name || '',
                        arguments: JSON.stringify(block.input || {})
                    });
                } else if (block.type === 'tool_result') {
                    // Skip tool_result for WebSearch calls
                    if (webSearchToolUseIds.has(block.tool_use_id)) continue;
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

        // Filter out agent-spawning tools that Codex cannot handle properly
        // Task/dispatch_agent cause Codex to spawn unnecessary subagents
        const BLOCKED_TOOLS = new Set(['Task', 'dispatch_agent', 'computer', 'browser']);
        const otherTools = tools.filter(t =>
            t.name !== 'WebSearch' && t.name !== 'web_search' && !BLOCKED_TOOLS.has(t.name)
        );

        result.tools = [];

        // Inject Codex native web_search instead of function-based WebSearch
        if (hasWebSearch) {
            result.tools.push({ type: 'web_search' });
        }

        // Convert remaining function tools normally
        for (const t of otherTools) {
            const rawSchema = t.input_schema || t.function?.input_schema || t.function?.parameters || t.parameters;
            const parameters = normalizeFunctionParameters(sanitizeSchema(rawSchema));
            result.tools.push({
                type: 'function',
                name: t.name,
                description: t.description,
                parameters
            });
        }
    }

    // Convert Anthropic tool_choice format to OpenAI Responses API format
    if (tool_choice) {
        if (typeof tool_choice === 'string') {
            // Anthropic: "auto" | "any" | "none"
            if (tool_choice === 'any') {
                result.tool_choice = 'required';
            } else {
                result.tool_choice = tool_choice; // "auto" and "none" map directly
            }
        } else if (tool_choice && typeof tool_choice === 'object') {
            // Anthropic: { type: "tool", name: "tool_name" }
            if (tool_choice.type === 'tool' && tool_choice.name) {
                result.tool_choice = { type: 'function', name: tool_choice.name };
            } else if (tool_choice.type === 'auto') {
                result.tool_choice = 'auto';
            } else if (tool_choice.type === 'any') {
                result.tool_choice = 'required';
            } else if (tool_choice.type === 'none') {
                result.tool_choice = 'none';
            }
        }
    }
    // Do NOT default to required — let Codex decide when to use tools

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
                // web_search_call: Codex handles it natively, skip
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
    // track web_search_call item ids (handled natively by Codex, no round-trip needed)
    const webSearchItemIds = new Set();
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
                if (!item) continue;

                if (item.type === 'function_call') {
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
                // web_search_call: Codex handles it internally, no tool_result needed.
                // We track the item_id so we can ignore web_search_call.* lifecycle events.
                if (item.type === 'web_search_call') {
                    webSearchItemIds.add(item.id || '');
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
