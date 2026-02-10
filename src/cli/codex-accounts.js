#!/usr/bin/env node

/**
 * Codex Account Management CLI
 *
 * Usage:
 *   node src/cli/codex-accounts.js          # Interactive mode
 *   node src/cli/codex-accounts.js add
 *   node src/cli/codex-accounts.js list
 *   node src/cli/codex-accounts.js remove
 *   node src/cli/codex-accounts.js clear
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { CODEX_ACCOUNT_CONFIG_PATH, CODEX_OAUTH_CALLBACK_PORT } from '../constants.js';
import { getCodexAuthorizationUrl, startCodexCallbackServer, exchangeCodeForTokens, decodeIdToken } from '../codex/oauth.js';

function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

function openBrowser(url) {
    const platform = process.platform;
    let command;
    let args;

    if (platform === 'darwin') {
        command = 'open';
        args = [url];
    } else if (platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
        console.log('\nWarning: Could not open browser automatically.');
        console.log('Please open this URL manually:', url);
    });
    child.unref();
}

function loadAccounts() {
    try {
        if (existsSync(CODEX_ACCOUNT_CONFIG_PATH)) {
            const data = readFileSync(CODEX_ACCOUNT_CONFIG_PATH, 'utf-8');
            const config = JSON.parse(data);
            return config.accounts || [];
        }
    } catch (error) {
        console.error('Error loading codex accounts:', error.message);
    }
    return [];
}

function saveAccounts(accounts) {
    const dir = dirname(CODEX_ACCOUNT_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const config = {
        accounts: accounts.map(acc => ({
            id: acc.id,
            email: acc.email || undefined,
            refreshToken: acc.refreshToken,
            accessToken: acc.accessToken || undefined,
            expiresAt: acc.expiresAt || undefined,
            addedAt: acc.addedAt || new Date().toISOString(),
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false,
            isInvalid: acc.isInvalid || false,
            invalidReason: acc.invalidReason || null,
            cooldownUntil: acc.cooldownUntil || null
        })),
        activeIndex: 0
    };

    writeFileSync(CODEX_ACCOUNT_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`\n✓ Saved ${accounts.length} account(s) to ${CODEX_ACCOUNT_CONFIG_PATH}`);
}

function displayAccounts(accounts) {
    if (accounts.length === 0) {
        console.log('\nNo Codex accounts configured.');
        return;
    }

    console.log(`\n${accounts.length} Codex account(s) saved:`);
    accounts.forEach((acc, i) => {
        const label = acc.email || acc.id || `Account ${i + 1}`;
        console.log(`  ${i + 1}. ${label}`);
    });
}

async function addAccount(existingAccounts) {
    console.log('\n=== Add Codex Account ===\n');

    const redirectUri = `http://localhost:${CODEX_OAUTH_CALLBACK_PORT}/auth/callback`;
    const { url, verifier, state } = getCodexAuthorizationUrl(redirectUri);

    const { waitForCallback, close } = await startCodexCallbackServer(CODEX_OAUTH_CALLBACK_PORT);

    console.log('Opening browser for OpenAI sign-in...');
    console.log('(If browser does not open, copy this URL manually)\n');
    console.log(`   ${url}\n`);
    openBrowser(url);

    console.log('Waiting for authentication (timeout: 5 minutes)...\n');

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for auth')), 300000));
    const params = await Promise.race([waitForCallback(), timeout]);
    close();

    if (params.error) {
        throw new Error(params.error_description || params.error);
    }
    if (!params.code) {
        throw new Error('No authorization code received');
    }
    if (params.state && params.state !== state) {
        throw new Error('Invalid state returned from OAuth');
    }

    const tokens = await exchangeCodeForTokens(params.code, redirectUri, verifier);
    const idInfo = decodeIdToken(tokens.id_token) || {};
    const email = idInfo.email || null;
    const id = email || idInfo.sub || `codex_${Math.random().toString(36).slice(2, 10)}`;

    const account = {
        id,
        email,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
        addedAt: new Date().toISOString(),
        enabled: true
    };

    const exists = existingAccounts.find(a => a.id === id || (email && a.email === email));
    if (exists) {
        Object.assign(exists, account);
    } else {
        existingAccounts.push(account);
    }

    saveAccounts(existingAccounts);
}

async function removeAccount(accounts) {
    if (accounts.length === 0) {
        console.log('\nNo accounts to remove.');
        return;
    }
    const rl = createRL();
    displayAccounts(accounts);
    const answer = await rl.question('\nEnter number to remove: ');
    rl.close();

    const idx = Number(answer) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= accounts.length) {
        console.log('Invalid selection.');
        return;
    }

    const removed = accounts.splice(idx, 1);
    saveAccounts(accounts);
    console.log(`Removed: ${removed[0].email || removed[0].id}`);
}

async function clearAccounts() {
    saveAccounts([]);
}

async function main() {
    const cmd = process.argv[2];
    const accounts = loadAccounts();

    if (cmd === 'add') {
        await addAccount(accounts);
        return;
    }
    if (cmd === 'list') {
        displayAccounts(accounts);
        return;
    }
    if (cmd === 'remove') {
        await removeAccount(accounts);
        return;
    }
    if (cmd === 'clear') {
        await clearAccounts();
        return;
    }

    // Interactive menu
    const rl = createRL();
    console.log('\nCodex Account Manager');
    console.log('1) Add account');
    console.log('2) List accounts');
    console.log('3) Remove account');
    console.log('4) Clear all accounts');
    const choice = await rl.question('\nChoose an option: ');
    rl.close();

    if (choice === '1') return addAccount(accounts);
    if (choice === '2') return displayAccounts(accounts);
    if (choice === '3') return removeAccount(accounts);
    if (choice === '4') return clearAccounts();

    console.log('Invalid choice.');
}

main().catch(err => {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
});
