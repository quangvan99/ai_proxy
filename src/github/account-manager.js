/**
 * GitHub Copilot Account Manager
 * Stores GitHub/Copilot accounts in a separate file and provides selection + refresh logic.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import crypto from 'crypto';
import { GITHUB_ACCOUNT_CONFIG_PATH, GITHUB_COPILOT_TOKEN_URL } from '../constants.js';
import { logger } from '../utils/logger.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function nowIso() {
    return new Date().toISOString();
}

function isExpiringSoon(expiresAt) {
    if (!expiresAt) return true;
    let ms = expiresAt;
    if (typeof expiresAt === 'number' && expiresAt < 1e12) {
        ms = expiresAt * 1000;
    } else if (typeof expiresAt === 'string') {
        ms = new Date(expiresAt).getTime();
    }
    return ms - Date.now() < REFRESH_BUFFER_MS;
}

async function refreshCopilotToken(accessToken) {
    try {
        const response = await fetch(GITHUB_COPILOT_TOKEN_URL, {
            headers: {
                'Authorization': `token ${accessToken}`,
                'User-Agent': 'GithubCopilot/1.0',
                'Editor-Version': 'vscode/1.100.0',
                'Editor-Plugin-Version': 'copilot/1.300.0',
                'Accept': 'application/json'
            }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return { token: data.token, expiresAt: data.expires_at };
    } catch (error) {
        logger.warn(`[GitHub] Copilot token refresh error: ${error.message}`);
        return null;
    }
}

export class GithubAccountManager {
    #accounts = [];
    #activeIndex = 0;
    #configPath;
    #initialized = false;

    constructor(configPath = GITHUB_ACCOUNT_CONFIG_PATH) {
        this.#configPath = configPath;
    }

    async initialize() {
        if (this.#initialized) return;
        try {
            const raw = await readFile(this.#configPath, 'utf8');
            const config = JSON.parse(raw);
            this.#accounts = (config.accounts || []).map(acc => ({
                id: acc.id || acc.email || `github_${crypto.randomBytes(6).toString('hex')}`,
                email: acc.email || null,
                accessToken: acc.accessToken || null,
                refreshToken: acc.refreshToken || null,
                copilotToken: acc.copilotToken || null,
                copilotTokenExpiresAt: acc.copilotTokenExpiresAt || null,
                addedAt: acc.addedAt || nowIso(),
                lastUsed: acc.lastUsed || null,
                enabled: acc.enabled !== false,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                cooldownUntil: acc.cooldownUntil || null
            }));
            this.#activeIndex = config.activeIndex || 0;
            this.#initialized = true;
            logger.info(`[GitHub] Loaded ${this.#accounts.length} account(s)`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('[GitHub] No GitHub accounts file found.');
            } else {
                logger.error('[GitHub] Failed to load GitHub accounts:', error.message);
            }
            this.#accounts = [];
            this.#activeIndex = 0;
            this.#initialized = true;
        }
    }

    getAccountCount() {
        return this.#accounts.length;
    }

    getAvailableAccounts() {
        const now = Date.now();
        return this.#accounts.filter(acc => {
            if (!acc.enabled) return false;
            if (acc.isInvalid) return false;
            if (acc.cooldownUntil && new Date(acc.cooldownUntil).getTime() > now) return false;
            return true;
        });
    }

    getMinWaitMs() {
        const now = Date.now();
        const future = this.#accounts
            .map(acc => acc.cooldownUntil ? new Date(acc.cooldownUntil).getTime() : null)
            .filter(ts => ts && ts > now);
        if (future.length === 0) return 0;
        return Math.max(0, Math.min(...future) - now);
    }

    selectAccount() {
        const total = this.#accounts.length;
        if (total === 0) return { account: null, waitMs: 0 };

        const now = Date.now();
        for (let i = 0; i < total; i++) {
            const idx = (this.#activeIndex + i) % total;
            const acc = this.#accounts[idx];
            if (!acc.enabled || acc.isInvalid) continue;
            if (acc.cooldownUntil && new Date(acc.cooldownUntil).getTime() > now) continue;
            this.#activeIndex = (idx + 1) % total;
            acc.lastUsed = nowIso();
            this.saveToDisk().catch(() => {});
            return { account: acc, waitMs: 0 };
        }

        return { account: null, waitMs: this.getMinWaitMs() };
    }

    async getCopilotToken(account) {
        if (account.copilotToken && !isExpiringSoon(account.copilotTokenExpiresAt)) {
            return account.copilotToken;
        }

        if (!account.accessToken) {
            throw new Error('Missing GitHub access token for Copilot');
        }

        const refreshed = await refreshCopilotToken(account.accessToken);
        if (!refreshed?.token) {
            throw new Error('Failed to refresh Copilot token');
        }

        account.copilotToken = refreshed.token;
        account.copilotTokenExpiresAt = refreshed.expiresAt || account.copilotTokenExpiresAt;
        await this.saveToDisk();
        return account.copilotToken;
    }

    markRateLimited(accountId, waitMs) {
        const acc = this.#accounts.find(a => a.id === accountId || a.email === accountId);
        if (!acc) return;
        acc.cooldownUntil = new Date(Date.now() + waitMs).toISOString();
        this.saveToDisk().catch(() => {});
    }

    markInvalid(accountId, reason) {
        const acc = this.#accounts.find(a => a.id === accountId || a.email === accountId);
        if (!acc) return;
        acc.isInvalid = true;
        acc.invalidReason = reason || 'invalid';
        this.saveToDisk().catch(() => {});
    }

    async addAccount(account) {
        const exists = this.#accounts.find(a => a.id === account.id || (account.email && a.email === account.email));
        if (exists) {
            Object.assign(exists, account, { enabled: true, isInvalid: false, invalidReason: null });
        } else {
            this.#accounts.push(account);
        }
        await this.saveToDisk();
    }

    async saveToDisk() {
        const dir = dirname(this.#configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: this.#accounts.map(acc => ({
                id: acc.id,
                email: acc.email || undefined,
                accessToken: acc.accessToken || undefined,
                refreshToken: acc.refreshToken || undefined,
                copilotToken: acc.copilotToken || undefined,
                copilotTokenExpiresAt: acc.copilotTokenExpiresAt || undefined,
                addedAt: acc.addedAt || undefined,
                lastUsed: acc.lastUsed || undefined,
                enabled: acc.enabled !== false,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                cooldownUntil: acc.cooldownUntil || null
            })),
            activeIndex: this.#activeIndex
        };

        await writeFile(this.#configPath, JSON.stringify(config, null, 2), 'utf8');
    }
}
