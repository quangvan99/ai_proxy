/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

// Initialize proxy support BEFORE any other imports that may use fetch
import './utils/proxy.js';

import app, { accountManager } from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { getStrategyLabel } from './account-manager/strategies/index.js';
import { getPackageVersion } from './utils/helpers.js';
import path from 'path';
import os from 'os';

const packageVersion = getPackageVersion();

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || args.includes('--dev-mode') || process.env.DEBUG === 'true' || process.env.DEV_MODE === 'true';

// Note: --strategy flag is ignored, only Hybrid Strategy is supported

// Initialize logger and devMode
logger.setDebug(isDebug);

if (isDebug) {
    config.devMode = true;
    config.debug = true;
    logger.debug('Developer mode enabled');
}

const PORT = process.env.PORT || DEFAULT_PORT;
const HOST = process.env.HOST || '0.0.0.0';

if (process.env.HOST) {
    logger.info(`[Startup] Using HOST environment variable: ${process.env.HOST}`);
}

// Account storage directory
const STORAGE_DIR = process.cwd();

const server = app.listen(PORT, HOST, () => {
    // Get actual bound address
    const address = server.address();
    const boundHost = typeof address === 'string' ? address : address.address;
    const boundPort = typeof address === 'string' ? null : address.port;

    // Clear console for a clean start
    console.clear();

    const border = '║';
    // align for 2-space indent (60 chars), align4 for 4-space indent (58 chars)
    const align = (text) => text + ' '.repeat(Math.max(0, 60 - text.length));
    const align4 = (text) => text + ' '.repeat(Math.max(0, 58 - text.length));

    // Build Control section dynamically
    let controlSection = '║  Control:                                                    ║\n';
    if (!isDebug) {
        controlSection += '║    --dev-mode         Enable developer mode                  ║\n';
    }
    controlSection += '║    Ctrl+C             Stop server                            ║';

    // Get the strategy label (accountManager will be initialized by now)
    const strategyLabel = getStrategyLabel();

    // Build status section - always show strategy, plus any active modes
    let statusSection = '║                                                              ║\n';
    statusSection += '║  Active Modes:                                               ║\n';
    statusSection += `${border}    ${align4(`✓ Strategy: ${strategyLabel}`)}${border}\n`;
    if (isDebug) {
        statusSection += '║    ✓ Developer mode enabled                                   ║\n';
    }

    const environmentSection = `║  Environment Variables:                                      ║
║    PORT                Server port (default: 8386)           ║
║    HOST                Bind address (default: 0.0.0.0)       ║
║    HTTP_PROXY          Route requests through a proxy        ║
║    See README.md for detailed configuration examples         ║`

    logger.log(`
╔══════════════════════════════════════════════════════════════╗
║            Antigravity Claude Proxy Server v${packageVersion}            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${border}  ${align(`Server running at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)}${border}
${border}  ${align(`Bound to: ${boundHost}:${boundPort}`)}${border}
${statusSection}║                                                              ║
${controlSection}
║                                                              ║
║  Endpoints:                                                  ║
║    POST /v1/messages         - Anthropic Messages API        ║
║    GET  /v1/models           - List available models         ║
║    GET  /health              - Health check                  ║
║    GET  /account-limits      - Account status & quotas       ║
║    POST /refresh-token       - Force token refresh           ║
║                                                              ║
${border}  ${align(`Configuration:`)}${border}
${border}    ${align4(`Storage: ${STORAGE_DIR}`)}${border}
║                                                              ║
║  Usage with Claude Code:                                     ║
${border}    ${align4(`export ANTHROPIC_BASE_URL=http://localhost:${PORT}`)}${border}
${border}    ${align4(`export ANTHROPIC_API_KEY=${config.apiKey || 'dummy'}`)}${border}
║    claude                                                    ║
║                                                              ║
║  Add Google accounts:                                        ║
║    npm run accounts                                          ║
║                                                              ║
║  Add Codex accounts:                                         ║
║    npm run codex:accounts                                    ║
║                                                              ║
║  Add Cursor accounts:                                        ║
║    npm run cursor:accounts                                   ║
║                                                              ║
║  Add GitHub Copilot accounts:                                ║
║    npm run github:accounts                                   ║
║                                                              ║
${environmentSection}
╚══════════════════════════════════════════════════════════════╝
  `);

    logger.success(`Server started successfully on port ${PORT}`);
    if (isDebug) {
        logger.warn('Running in DEVELOPER mode - verbose logs enabled');
    }
});

// Graceful shutdown
const shutdown = () => {
    logger.info('Shutting down server...');
    server.close(() => {
        logger.success('Server stopped');
        process.exit(0);
    });

    // Force close if it takes too long
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
