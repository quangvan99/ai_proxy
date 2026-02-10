/**
 * Codex (OpenAI) OAuth utilities
 */

import crypto from 'crypto';
import http from 'http';
import {
    CODEX_OAUTH_AUTHORIZE_URL,
    CODEX_OAUTH_TOKEN_URL,
    CODEX_OAUTH_CLIENT_ID,
    CODEX_OAUTH_SCOPE,
    CODEX_OAUTH_EXTRA_PARAMS,
    CODEX_OAUTH_CALLBACK_PORT
} from '../constants.js';

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

/**
 * Build Codex OAuth authorization URL
 * @param {string} redirectUri
 * @param {string} state
 * @param {string} codeChallenge
 * @returns {string}
 */
export function buildCodexAuthUrl(redirectUri, state, codeChallenge) {
    const params = {
        response_type: 'code',
        client_id: CODEX_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: CODEX_OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        ...CODEX_OAUTH_EXTRA_PARAMS
    };

    const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');

    return `${CODEX_OAUTH_AUTHORIZE_URL}?${queryString}`;
}

/**
 * Start local callback server (fixed port)
 * @param {number} [port]
 * @returns {Promise<{port: number, waitForCallback: () => Promise<Object>, close: () => void}>}
 */
export function startCodexCallbackServer(port = CODEX_OAUTH_CALLBACK_PORT) {
    let resolveCallback;
    let rejectCallback;

    const waitForCallback = () => new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });

    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url || '/', `http://localhost:${port}`);
            if (url.pathname !== '/auth/callback') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }

            const params = Object.fromEntries(url.searchParams.entries());
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Authentication complete. You can close this window.');
            if (resolveCallback) resolveCallback(params);
        } catch (error) {
            if (rejectCallback) rejectCallback(error);
        }
    });

    return new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => {
            resolve({
                port,
                waitForCallback,
                close: () => server.close()
            });
        });
        server.on('error', reject);
    });
}

/**
 * Exchange authorization code for tokens
 * @param {string} code
 * @param {string} redirectUri
 * @param {string} codeVerifier
 * @returns {Promise<Object>}
 */
export async function exchangeCodeForTokens(code, redirectUri, codeVerifier) {
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CODEX_OAUTH_CLIENT_ID,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    return await response.json();
}

/**
 * Refresh Codex access token using refresh token
 * @param {string} refreshToken
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}|null>}
 */
export async function refreshCodexToken(refreshToken) {
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CODEX_OAUTH_CLIENT_ID,
            scope: CODEX_OAUTH_SCOPE
        })
    });

    if (!response.ok) {
        return null;
    }

    const tokens = await response.json();
    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in
    };
}

/**
 * Decode ID token to extract claims (email/sub)
 * @param {string} idToken
 * @returns {Object|null}
 */
export function decodeIdToken(idToken) {
    if (!idToken) return null;
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    try {
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

/**
 * Create auth URL and PKCE data
 * @param {string} redirectUri
 * @returns {{url: string, verifier: string, state: string}}
 */
export function getCodexAuthorizationUrl(redirectUri) {
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');
    const url = buildCodexAuthUrl(redirectUri, state, challenge);
    return { url, verifier, state };
}
