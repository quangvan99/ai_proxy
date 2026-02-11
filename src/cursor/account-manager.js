/**
 * Cursor Account Manager
 * Stores Cursor accounts in a separate file and provides selection logic.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import crypto from 'crypto';
import { CURSOR_ACCOUNT_CONFIG_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

function nowIso() {
  return new Date().toISOString();
}

export class CursorAccountManager {
  #accounts = [];
  #activeIndex = 0;
  #configPath;
  #initialized = false;

  constructor(configPath = CURSOR_ACCOUNT_CONFIG_PATH) {
    this.#configPath = configPath;
  }

  async initialize() {
    if (this.#initialized) return;
    try {
      const raw = await readFile(this.#configPath, 'utf8');
      const config = JSON.parse(raw);
      this.#accounts = (config.accounts || []).map(acc => ({
        id: acc.id || acc.email || `cursor_${crypto.randomBytes(6).toString('hex')}`,
        email: acc.email || null,
        accessToken: acc.accessToken,
        machineId: acc.machineId,
        ghostMode: acc.ghostMode !== false,
        addedAt: acc.addedAt || nowIso(),
        lastUsed: acc.lastUsed || null,
        enabled: acc.enabled !== false,
        isInvalid: acc.isInvalid || false,
        invalidReason: acc.invalidReason || null,
        cooldownUntil: acc.cooldownUntil || null
      }));
      this.#activeIndex = config.activeIndex || 0;
      this.#initialized = true;
      logger.info(`[Cursor] Loaded ${this.#accounts.length} account(s)`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('[Cursor] No cursor accounts file found.');
      } else {
        logger.error('[Cursor] Failed to load cursor accounts:', error.message);
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
        accessToken: acc.accessToken,
        machineId: acc.machineId,
        ghostMode: acc.ghostMode !== false,
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
