/**
 * Strategy Factory
 *
 * Creates and exports account selection strategy instances.
 * Only Hybrid Strategy (Smart Distribution) is supported.
 */

import { HybridStrategy } from './hybrid-strategy.js';
import { logger } from '../../utils/logger.js';

/**
 * Create a strategy instance
 * Always returns HybridStrategy (Smart Distribution)
 * @param {string} strategyName - Ignored, always uses hybrid
 * @param {Object} config - Strategy configuration
 * @returns {HybridStrategy} The hybrid strategy instance
 */
export function createStrategy(strategyName, config = {}) {
    if (strategyName && strategyName.toLowerCase() !== 'hybrid') {
        logger.warn(`[Strategy] Only "hybrid" strategy is supported. Ignoring: "${strategyName}"`);
    }
    logger.debug('[Strategy] Creating HybridStrategy (Smart Distribution)');
    return new HybridStrategy(config);
}

/**
 * Check if a strategy name is valid
 * @param {string} name - Strategy name to check
 * @returns {boolean} True if 'hybrid' or empty (defaults to hybrid)
 */
export function isValidStrategy(name) {
    if (!name) return true; // Empty defaults to hybrid
    return name.toLowerCase() === 'hybrid';
}

/**
 * Get the display label for the strategy
 * @param {string} name - Strategy name (ignored)
 * @returns {string} Display label
 */
export function getStrategyLabel(name) {
    return 'Hybrid (Smart Distribution)';
}

// Re-export strategy for direct use
export { HybridStrategy } from './hybrid-strategy.js';
export { BaseStrategy } from './base-strategy.js';

// Re-export trackers
export { HealthTracker, TokenBucketTracker, QuotaTracker } from './trackers/index.js';

