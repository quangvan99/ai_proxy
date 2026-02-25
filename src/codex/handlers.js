/**
 * Codex request handlers (Responses API)
 */

import { CODEX_BASE_URL, CODEX_HEADERS, DEFAULT_COOLDOWN_MS } from '../constants.js';
import { convertAnthropicToCodexRequest, collectCodexStreamToAnthropicResponse, streamCodexResponseToAnthropic } from './format.js';
import { sleep } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

function buildHeaders(accessToken, stream) {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...CODEX_HEADERS
    };
    if (stream) headers.Accept = 'text/event-stream';
    return headers;
}

function parseRetryAfter(response, bodyText) {
    // Check retry-after header first
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds) && seconds > 0) {
            return seconds * 1000;
        }
    }

    // Codex returns resets_in_seconds or resets_at in the JSON body
    if (bodyText) {
        try {
            const body = JSON.parse(bodyText);
            const err = body?.error || body;
            if (err?.resets_in_seconds > 0) {
                return err.resets_in_seconds * 1000;
            }
            if (err?.resets_at) {
                const ms = new Date(err.resets_at * 1000).getTime() - Date.now();
                if (ms > 0) return ms;
            }
        } catch {
            // ignore parse error
        }
    }

    return null;
}

/**
 * Send non-streaming Codex request
 */
export async function sendCodexMessage(anthropicRequest, codexAccountManager) {
    // Codex endpoint requires stream=true; we will aggregate the stream into a single response.
    const body = convertAnthropicToCodexRequest({ ...anthropicRequest, stream: true });
    body.stream = true;

    const maxAttempts = Math.max(3, codexAccountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { account, waitMs } = codexAccountManager.selectAccount();

        if (!account && waitMs > 0) {
            if (waitMs > 60_000) {
                const resetMins = Math.ceil(waitMs / 60_000);
                throw new Error(`RESOURCE_EXHAUSTED: All Codex accounts have reached their usage limit. Quota resets in approximately ${resetMins} minutes.`);
            }
            await sleep(waitMs + 500);
            attempt--;
            continue;
        }

        if (!account) {
            throw new Error('No Codex accounts available');
        }

        try {
            const accessToken = await codexAccountManager.getTokenForAccount(account);
            const response = await fetch(CODEX_BASE_URL, {
                method: 'POST',
                headers: buildHeaders(accessToken, false),
                body: JSON.stringify(body)
            });

            if (response.ok) {
                return await collectCodexStreamToAnthropicResponse(response, anthropicRequest.model);
            }

            const errorText = await response.text().catch(() => '');
            logger.warn(`[Codex] Error ${response.status}: ${errorText}`);

            if (response.status === 401 || response.status === 403) {
                codexAccountManager.markInvalid(account.id, 'Unauthorized');
                continue;
            }

            if (response.status === 429) {
                const retryMs = parseRetryAfter(response, errorText) || DEFAULT_COOLDOWN_MS;
                codexAccountManager.markRateLimited(account.id, retryMs);
                continue;
            }

            throw new Error(`Codex error ${response.status}: ${errorText}`);
        } catch (error) {
            if (attempt + 1 >= maxAttempts) throw error;
        }
    }

    throw new Error('Codex request failed after retries');
}

/**
 * Send streaming Codex request
 */
export async function* sendCodexMessageStream(anthropicRequest, codexAccountManager) {
    const body = convertAnthropicToCodexRequest({ ...anthropicRequest, stream: true });
    body.stream = true;

    // Debug: log exactly what we send to Codex
    logger.debug('[Codex] Request body:\n' + JSON.stringify(body, null, 2));

    const maxAttempts = Math.max(3, codexAccountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { account, waitMs } = codexAccountManager.selectAccount();

        if (!account && waitMs > 0) {
            // If all accounts are on cooldown for more than 60s, fail fast with a quota error
            // so Claude Code CLI knows to stop rather than hanging
            if (waitMs > 60_000) {
                const resetMins = Math.ceil(waitMs / 60_000);
                throw new Error(`RESOURCE_EXHAUSTED: All Codex accounts have reached their usage limit. Quota resets in approximately ${resetMins} minutes.`);
            }
            await sleep(waitMs + 500);
            attempt--;
            continue;
        }

        if (!account) {
            throw new Error('No Codex accounts available');
        }

        try {
            const accessToken = await codexAccountManager.getTokenForAccount(account);
            const response = await fetch(CODEX_BASE_URL, {
                method: 'POST',
                headers: buildHeaders(accessToken, true),
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[Codex] Stream error ${response.status}: ${errorText}`);

                if (response.status === 401 || response.status === 403) {
                    codexAccountManager.markInvalid(account.id, 'Unauthorized');
                    continue;
                }

                if (response.status === 429) {
                    const retryMs = parseRetryAfter(response, errorText) || DEFAULT_COOLDOWN_MS;
                    codexAccountManager.markRateLimited(account.id, retryMs);
                    continue;
                }

                throw new Error(`Codex stream error ${response.status}: ${errorText}`);
            }

            for await (const event of streamCodexResponseToAnthropic(response, anthropicRequest.model)) {
                yield event;
            }
            return;
        } catch (error) {
            if (attempt + 1 >= maxAttempts) throw error;
        }
    }

    throw new Error('Codex stream failed after retries');
}

export function listCodexModels(models) {
    const created = Math.floor(Date.now() / 1000);
    return {
        object: 'list',
        data: models.map(id => ({
            id,
            object: 'model',
            created,
            owned_by: 'openai',
            description: id
        }))
    };
}

export function isValidCodexModel(modelId, models) {
    return models.includes(modelId);
}
