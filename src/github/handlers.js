/**
 * GitHub Copilot request handlers (OpenAI Chat Completions)
 */

import { GITHUB_COPILOT_BASE_URL, GITHUB_COPILOT_HEADERS, DEFAULT_COOLDOWN_MS } from '../constants.js';
import { convertAnthropicToOpenAIRequest, convertOpenAIResponseToAnthropic, collectOpenAIStreamToAnthropic, streamOpenAIResponseToAnthropic } from './format.js';
import { sleep } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

function buildHeaders(copilotToken, stream) {
    return {
        Authorization: `Bearer ${copilotToken}`,
        ...GITHUB_COPILOT_HEADERS,
        Accept: stream ? 'text/event-stream' : 'application/json'
    };
}

export async function sendGithubMessage(anthropicRequest, githubAccountManager) {
    const body = convertAnthropicToOpenAIRequest({ ...anthropicRequest, stream: true });
    body.stream = true;

    const maxAttempts = Math.max(3, githubAccountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { account, waitMs } = githubAccountManager.selectAccount();

        if (!account && waitMs > 0) {
            await sleep(waitMs + 500);
            attempt--;
            continue;
        }

        if (!account) {
            throw new Error('No GitHub Copilot accounts available');
        }

        try {
            const copilotToken = await githubAccountManager.getCopilotToken(account);
            const response = await fetch(GITHUB_COPILOT_BASE_URL, {
                method: 'POST',
                headers: buildHeaders(copilotToken, true),
                body: JSON.stringify(body)
            });

            if (response.ok) {
                return await collectOpenAIStreamToAnthropic(response, anthropicRequest.model);
            }

            const errorText = await response.text().catch(() => '');
            logger.warn(`[GitHub] Error ${response.status}: ${errorText}`);

            if (response.status === 401 || response.status === 403) {
                githubAccountManager.markInvalid(account.id, 'Unauthorized');
                continue;
            }

            if (response.status === 429) {
                githubAccountManager.markRateLimited(account.id, DEFAULT_COOLDOWN_MS);
                continue;
            }

            throw new Error(`GitHub Copilot error ${response.status}: ${errorText}`);
        } catch (error) {
            if (attempt + 1 >= maxAttempts) throw error;
        }
    }

    throw new Error('GitHub Copilot request failed after retries');
}

export async function* sendGithubMessageStream(anthropicRequest, githubAccountManager) {
    const body = convertAnthropicToOpenAIRequest({ ...anthropicRequest, stream: true });
    body.stream = true;

    const maxAttempts = Math.max(3, githubAccountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { account, waitMs } = githubAccountManager.selectAccount();

        if (!account && waitMs > 0) {
            await sleep(waitMs + 500);
            attempt--;
            continue;
        }

        if (!account) {
            throw new Error('No GitHub Copilot accounts available');
        }

        try {
            const copilotToken = await githubAccountManager.getCopilotToken(account);
            const response = await fetch(GITHUB_COPILOT_BASE_URL, {
                method: 'POST',
                headers: buildHeaders(copilotToken, true),
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[GitHub] Stream error ${response.status}: ${errorText}`);

                if (response.status === 401 || response.status === 403) {
                    githubAccountManager.markInvalid(account.id, 'Unauthorized');
                    continue;
                }

                if (response.status === 429) {
                    githubAccountManager.markRateLimited(account.id, DEFAULT_COOLDOWN_MS);
                    continue;
                }

                throw new Error(`GitHub Copilot stream error ${response.status}: ${errorText}`);
            }

            for await (const event of streamOpenAIResponseToAnthropic(response, anthropicRequest.model)) {
                yield event;
            }
            return;
        } catch (error) {
            if (attempt + 1 >= maxAttempts) throw error;
        }
    }

    throw new Error('GitHub Copilot stream failed after retries');
}

export function listGithubModels(models, prefix = 'gh') {
    const created = Math.floor(Date.now() / 1000);
    return {
        object: 'list',
        data: models.map(id => ({
            id: prefix ? `${prefix}/${id}` : id,
            object: 'model',
            created,
            owned_by: 'github',
            description: id
        }))
    };
}

export function isValidGithubModel(modelId, models) {
    const normalized = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
    return models.includes(normalized);
}
