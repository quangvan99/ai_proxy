#!/usr/bin/env node

/**
 * Cursor Account Management CLI
 *
 * Usage:
 *   node src/cli/cursor-accounts.js          # Interactive mode
 *   node src/cli/cursor-accounts.js add
 *   node src/cli/cursor-accounts.js list
 *   node src/cli/cursor-accounts.js remove
 *   node src/cli/cursor-accounts.js clear
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { CURSOR_ACCOUNT_CONFIG_PATH } from '../constants.js';

function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

function loadAccounts() {
    try {
        if (existsSync(CURSOR_ACCOUNT_CONFIG_PATH)) {
            const data = readFileSync(CURSOR_ACCOUNT_CONFIG_PATH, 'utf-8');
            const config = JSON.parse(data);
            return config.accounts || [];
        }
    } catch (error) {
        console.error('Error loading cursor accounts:', error.message);
    }
    return [];
}

function saveAccounts(accounts) {
    const dir = dirname(CURSOR_ACCOUNT_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const config = {
        accounts: accounts.map(acc => ({
            id: acc.id,
            email: acc.email || undefined,
            accessToken: acc.accessToken,
            machineId: acc.machineId,
            ghostMode: acc.ghostMode !== false,
            addedAt: acc.addedAt || new Date().toISOString(),
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false,
            isInvalid: acc.isInvalid || false,
            invalidReason: acc.invalidReason || null,
            cooldownUntil: acc.cooldownUntil || null
        })),
        activeIndex: 0
    };

    writeFileSync(CURSOR_ACCOUNT_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`\n✓ Saved ${accounts.length} account(s) to ${CURSOR_ACCOUNT_CONFIG_PATH}`);
}

function displayAccounts(accounts) {
    if (accounts.length === 0) {
        console.log('\nNo Cursor accounts configured.');
        return;
    }

    console.log(`\n${accounts.length} Cursor account(s) saved:`);
    accounts.forEach((acc, i) => {
        const label = acc.email || acc.id || `Account ${i + 1}`;
        const status = acc.enabled === false ? ' (disabled)' : '';
        console.log(`  ${i + 1}. ${label}${status}`);
    });
}

function resolveCursorDbPath() {
    const platform = process.platform;
    if (platform === 'darwin') {
        return join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    }
    if (platform === 'linux') {
        return join(homedir(), '.config/Cursor/User/globalStorage/state.vscdb');
    }
    if (platform === 'win32') {
        return join(process.env.APPDATA || '', 'Cursor/User/globalStorage/state.vscdb');
    }
    return null;
}

function normalizeValue(val) {
    if (!val) return val;
    const trimmed = String(val).trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

async function tryReadWithBetterSqlite3(dbPath) {
    try {
        const mod = await import('better-sqlite3');
        const Database = mod.default || mod;
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const rows = db.prepare(
            'SELECT key, value FROM itemTable WHERE key IN (?, ?)'
        ).all('cursorAuth/accessToken', 'storage.serviceMachineId');
        db.close();

        const tokens = {};
        for (const row of rows) {
            if (row.key === 'cursorAuth/accessToken') tokens.accessToken = normalizeValue(row.value);
            if (row.key === 'storage.serviceMachineId') tokens.machineId = normalizeValue(row.value);
        }
        return tokens.accessToken && tokens.machineId ? tokens : null;
    } catch {
        return null;
    }
}

function tryReadWithSqlite3(dbPath) {
    try {
        const output = execFileSync(
            'sqlite3',
            ['-separator', '\t', dbPath, "SELECT key, value FROM itemTable WHERE key IN ('cursorAuth/accessToken', 'storage.serviceMachineId');"],
            { encoding: 'utf8' }
        );
        const tokens = {};
        const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const [key, value] = line.split('\t');
            if (!key) continue;
            if (key === 'cursorAuth/accessToken') tokens.accessToken = normalizeValue(value);
            if (key === 'storage.serviceMachineId') tokens.machineId = normalizeValue(value);
        }
        return tokens.accessToken && tokens.machineId ? tokens : null;
    } catch {
        return null;
    }
}

async function autoDetectCursorTokens() {
    const dbPath = resolveCursorDbPath();
    if (!dbPath || !existsSync(dbPath)) return null;

    const tokensFromLib = await tryReadWithBetterSqlite3(dbPath);
    if (tokensFromLib) return tokensFromLib;

    return tryReadWithSqlite3(dbPath);
}

async function addAccount(existingAccounts) {
    console.log('\n=== Add Cursor Account ===\n');

    let accessToken = '';
    let machineId = '';
    let email = '';
    let ghostAnswer = '';

    const autoTokens = await autoDetectCursorTokens();
    if (autoTokens?.accessToken && autoTokens?.machineId) {
        const rl = createRL();
        const useAuto = (await rl.question('Detected Cursor token from local DB. Use it? (Y/n): ')).trim().toLowerCase();
        rl.close();

        if (useAuto !== 'n' && useAuto !== 'no') {
            accessToken = autoTokens.accessToken;
            machineId = autoTokens.machineId;
        }
    } else {
        const dbPath = resolveCursorDbPath();
        if (dbPath) {
            console.log(`Auto-detect not available. Expected DB at: ${dbPath}`);
            console.log('Make sure Cursor IDE is installed and logged in.');
        }
    }

    if (!accessToken || !machineId) {
        const rl = createRL();
        accessToken = (await rl.question('Access Token (required): ')).trim();
        machineId = (await rl.question('Machine ID (required): ')).trim();
        email = (await rl.question('Email (optional): ')).trim();
        ghostAnswer = (await rl.question('Enable ghost mode? (Y/n): ')).trim().toLowerCase();
        rl.close();
    } else {
        const rl = createRL();
        email = (await rl.question('Email (optional): ')).trim();
        ghostAnswer = (await rl.question('Enable ghost mode? (Y/n): ')).trim().toLowerCase();
        rl.close();
    }

    if (!accessToken || !machineId) {
        console.log('Access token and machine ID are required.');
        return;
    }

    const account = {
        id: email || `cursor_${Math.random().toString(36).slice(2, 10)}`,
        email: email || null,
        accessToken,
        machineId,
        ghostMode: ghostAnswer !== 'n' && ghostAnswer !== 'no',
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

    // Interactive menu
    const rl = createRL();
    console.log('\nCursor Account Manager');
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
