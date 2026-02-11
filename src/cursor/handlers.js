/**
 * Cursor request handlers (ConnectRPC protobuf)
 */

import crypto from 'crypto';
import http2 from 'http2';
import { CURSOR_BASE_URL, CURSOR_CHAT_PATH, CURSOR_HEADERS, DEFAULT_COOLDOWN_MS } from '../constants.js';
import { buildCursorBodyFromAnthropic, buildAnthropicResponseFromCursor, streamCursorResponseToAnthropic, normalizeCursorModel } from './format.js';
import { sleep } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

function generateChecksum(machineId) {
  const timestamp = Math.floor(Date.now() / 1000000);
  const byteArray = new Uint8Array([
    (timestamp >> 40) & 0xFF,
    (timestamp >> 32) & 0xFF,
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF
  ]);

  let t = 165;
  for (let i = 0; i < byteArray.length; i++) {
    byteArray[i] = ((byteArray[i] ^ t) + (i % 256)) & 0xFF;
    t = byteArray[i];
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';

  for (let i = 0; i < byteArray.length; i += 3) {
    const a = byteArray[i];
    const b = i + 1 < byteArray.length ? byteArray[i + 1] : 0;
    const c = i + 2 < byteArray.length ? byteArray[i + 2] : 0;

    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 3) << 4) | (b >> 4)];

    if (i + 1 < byteArray.length) {
      encoded += alphabet[((b & 15) << 2) | (c >> 6)];
    }
    if (i + 2 < byteArray.length) {
      encoded += alphabet[c & 63];
    }
  }

  return `${encoded}${machineId}`;
}

function buildHeaders(credentials) {
  const accessToken = credentials.accessToken || '';
  const machineId = credentials.machineId;
  const ghostMode = credentials.ghostMode !== false;

  if (!machineId) {
    throw new Error('Machine ID is required for Cursor API');
  }

  const cleanToken = accessToken.includes('::') ? accessToken.split('::')[1] : accessToken;

  return {
    ...CURSOR_HEADERS,
    authorization: `Bearer ${cleanToken}`,
    'x-amzn-trace-id': `Root=${crypto.randomUUID()}`,
    'x-client-key': crypto.createHash('sha256').update(cleanToken).digest('hex'),
    'x-cursor-checksum': generateChecksum(machineId),
    'x-cursor-client-version': '2.3.41',
    'x-cursor-client-type': 'ide',
    'x-cursor-client-os': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    'x-cursor-client-arch': process.arch === 'arm64' ? 'aarch64' : 'x64',
    'x-cursor-client-device-type': 'desktop',
    'x-cursor-config-version': crypto.randomUUID(),
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-ghost-mode': ghostMode ? 'true' : 'false',
    'x-request-id': crypto.randomUUID(),
    'x-session-id': crypto.randomUUID()
  };
}

async function makeFetchRequest(url, headers, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer())
  };
}

function makeHttp2Request(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunks = [];
    let responseHeaders = {};

    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': urlObj.pathname,
      ':authority': urlObj.host,
      ':scheme': 'https',
      ...headers
    });

    req.on('response', (hdrs) => { responseHeaders = hdrs; });
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      client.close();
      resolve({
        status: responseHeaders[':status'],
        headers: responseHeaders,
        body: Buffer.concat(chunks)
      });
    });
    req.on('error', (err) => {
      client.close();
      reject(err);
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.close();
        client.close();
        reject(new Error('Request aborted'));
      });
    }

    req.write(body);
    req.end();
  });
}

async function sendCursorRequest(anthropicRequest, account) {
  const { model, originalModel, body } = buildCursorBodyFromAnthropic(anthropicRequest);
  const url = `${CURSOR_BASE_URL}${CURSOR_CHAT_PATH}`;
  const headers = buildHeaders({
    accessToken: account.accessToken,
    machineId: account.machineId,
    ghostMode: account.ghostMode
  });

  const response = http2 ? await makeHttp2Request(url, headers, body) : await makeFetchRequest(url, headers, body);
  return { response, resolvedModel: model, originalModel: originalModel || anthropicRequest.model };
}

export async function sendCursorMessage(anthropicRequest, cursorAccountManager) {
  const maxAttempts = Math.max(3, cursorAccountManager.getAccountCount() + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { account, waitMs } = cursorAccountManager.selectAccount();

    if (!account && waitMs > 0) {
      await sleep(waitMs + 500);
      attempt--;
      continue;
    }

    if (!account) {
      throw new Error('No Cursor accounts available');
    }

    try {
      const { response, resolvedModel, originalModel } = await sendCursorRequest(anthropicRequest, account);

      if (response.status === 401 || response.status === 403) {
        cursorAccountManager.markInvalid(account.id, 'Unauthorized');
        continue;
      }

      if (response.status === 429) {
        cursorAccountManager.markRateLimited(account.id, DEFAULT_COOLDOWN_MS);
        continue;
      }

      if (response.status !== 200) {
        const err = new Error(`Cursor error ${response.status}: ${response.body?.toString() || ''}`);
        err.statusCode = response.status;
        throw err;
      }

      try {
        return buildAnthropicResponseFromCursor(response.body, originalModel || resolvedModel);
      } catch (error) {
        if (error.statusCode === 401 || error.statusCode === 403) {
          cursorAccountManager.markInvalid(account.id, 'Unauthorized');
          continue;
        }
        if (error.statusCode === 429) {
          cursorAccountManager.markRateLimited(account.id, DEFAULT_COOLDOWN_MS);
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw error;
      logger.warn(`[Cursor] Request failed, retrying: ${error.message}`);
    }
  }

  throw new Error('Cursor request failed after retries');
}

export async function* sendCursorMessageStream(anthropicRequest, cursorAccountManager) {
  const maxAttempts = Math.max(3, cursorAccountManager.getAccountCount() + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { account, waitMs } = cursorAccountManager.selectAccount();

    if (!account && waitMs > 0) {
      await sleep(waitMs + 500);
      attempt--;
      continue;
    }

    if (!account) {
      throw new Error('No Cursor accounts available');
    }

    try {
      const { response, resolvedModel, originalModel } = await sendCursorRequest(anthropicRequest, account);

      if (response.status === 401 || response.status === 403) {
        cursorAccountManager.markInvalid(account.id, 'Unauthorized');
        continue;
      }

      if (response.status === 429) {
        cursorAccountManager.markRateLimited(account.id, DEFAULT_COOLDOWN_MS);
        continue;
      }

      if (response.status !== 200) {
        const err = new Error(`Cursor error ${response.status}: ${response.body?.toString() || ''}`);
        err.statusCode = response.status;
        throw err;
      }

      try {
        for await (const event of streamCursorResponseToAnthropic(response.body, originalModel || resolvedModel)) {
          yield event;
        }
        return;
      } catch (error) {
        if (error.statusCode === 401 || error.statusCode === 403) {
          cursorAccountManager.markInvalid(account.id, 'Unauthorized');
          continue;
        }
        if (error.statusCode === 429) {
          cursorAccountManager.markRateLimited(account.id, DEFAULT_COOLDOWN_MS);
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw error;
      logger.warn(`[Cursor] Stream failed, retrying: ${error.message}`);
    }
  }

  throw new Error('Cursor stream failed after retries');
}

export function listCursorModels(models, prefix = 'cu') {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: models.map(id => ({
      id: prefix ? `${prefix}/${id}` : id,
      object: 'model',
      created,
      owned_by: 'cursor',
      description: id
    }))
  };
}

export function isValidCursorModel(modelId, models) {
  const normalized = normalizeCursorModel(modelId);
  return models.includes(normalized);
}
