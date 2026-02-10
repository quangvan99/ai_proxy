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

function parseRetryAfter(response) {
    const retryAfter = response.headers?.get?.('retry-after');
    if (!retryAfter) return null;
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
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
                const retryMs = parseRetryAfter(response) || DEFAULT_COOLDOWN_MS;
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

    const maxAttempts = Math.max(3, codexAccountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { account, waitMs } = codexAccountManager.selectAccount();

        if (!account && waitMs > 0) {
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
                    const retryMs = parseRetryAfter(response) || DEFAULT_COOLDOWN_MS;
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
