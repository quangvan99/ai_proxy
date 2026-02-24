#!/usr/bin/env node

/**
 * GitHub Copilot Account Management CLI
 *
 * Usage:
 *   node src/cli/github-accounts.js          # Interactive mode
 *   node src/cli/github-accounts.js add
 *   node src/cli/github-accounts.js list
 *   node src/cli/github-accounts.js remove
 *   node src/cli/github-accounts.js clear
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { GITHUB_ACCOUNT_CONFIG_PATH, GITHUB_COPILOT_TOKEN_URL } from '../constants.js';

const TOKEN_URL = 'https://github.com/settings/tokens?type=beta';
const CLASSIC_URL = 'https://github.com/settings/tokens';

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
        console.log('\n⚠ Could not open browser automatically.');
        console.log('Please open this URL manually:', url);
    });
    child.unref();
}

function loadAccounts() {
    try {
        if (existsSync(GITHUB_ACCOUNT_CONFIG_PATH)) {
            const data = readFileSync(GITHUB_ACCOUNT_CONFIG_PATH, 'utf-8');
            const config = JSON.parse(data);
            return config.accounts || [];
        }
    } catch (error) {
        console.error('Error loading GitHub accounts:', error.message);
    }
    return [];
}

function saveAccounts(accounts) {
    const dir = dirname(GITHUB_ACCOUNT_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const config = {
        accounts: accounts.map(acc => ({
            id: acc.id,
            email: acc.email || undefined,
            accessToken: acc.accessToken || undefined,
            refreshToken: acc.refreshToken || undefined,
            copilotToken: acc.copilotToken || undefined,
            copilotTokenExpiresAt: acc.copilotTokenExpiresAt || undefined,
            addedAt: acc.addedAt || new Date().toISOString(),
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false,
            isInvalid: acc.isInvalid || false,
            invalidReason: acc.invalidReason || null,
            cooldownUntil: acc.cooldownUntil || null
        })),
        activeIndex: 0
    };

    writeFileSync(GITHUB_ACCOUNT_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`\n✓ Saved ${accounts.length} account(s) to ${GITHUB_ACCOUNT_CONFIG_PATH}`);
}

function displayAccounts(accounts) {
    if (accounts.length === 0) {
        console.log('\nNo GitHub Copilot accounts configured.');
        return;
    }

    console.log(`\n${accounts.length} GitHub Copilot account(s) saved:`);
    accounts.forEach((acc, i) => {
        const label = acc.email || acc.id || `Account ${i + 1}`;
        const status = acc.enabled === false ? ' (disabled)' : '';
        console.log(`  ${i + 1}. ${label}${status}`);
    });
}

async function fetchCopilotToken(accessToken) {
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
    } catch {
        return null;
    }
}

async function addAccount(existingAccounts) {
    console.log('\n=== Add GitHub Copilot Account ===\n');

    console.log('Opening GitHub token page...');
    console.log('(If browser does not open, copy these URLs manually)');
    console.log(`  Fine-grained: ${TOKEN_URL}`);
    console.log(`  Classic:      ${CLASSIC_URL}\n`);
    openBrowser(TOKEN_URL);

    const rl = createRL();
    const accessToken = (await rl.question('GitHub Access Token (required): ')).trim();
    const email = (await rl.question('Email (optional): ')).trim();
    rl.close();

    if (!accessToken) {
        console.log('Access token is required.');
        return;
    }

    const copilot = await fetchCopilotToken(accessToken);
    if (!copilot?.token) {
        console.log('Warning: failed to fetch Copilot token. The access token may be invalid.');
    }

    const account = {
        id: email || `github_${Math.random().toString(36).slice(2, 10)}`,
        email: email || null,
        accessToken,
        copilotToken: copilot?.token || null,
        copilotTokenExpiresAt: copilot?.expiresAt || null,
        addedAt: new Date().toISOString(),
        enabled: true
    };

    const exists = existingAccounts.find(a => a.id === account.id || (email && a.email === email));
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

    const rl = createRL();
    console.log('\nGitHub Copilot Account Manager');
    console.log('1. Add account');
    console.log('2. List accounts');
    console.log('3. Remove account');
    console.log('4. Clear all accounts');
    const choice = await rl.question('\nChoose an option (1-4): ');
    rl.close();

    switch (choice.trim()) {
        case '1':
            await addAccount(accounts);
            break;
        case '2':
            displayAccounts(accounts);
            break;
        case '3':
            await removeAccount(accounts);
            break;
        case '4':
            await clearAccounts();
            break;
        default:
            console.log('Invalid option.');
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
