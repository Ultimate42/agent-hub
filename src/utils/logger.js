import { config } from '../config.js';
import { maskToken } from './tokens.js';

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const currentLevel = levels[config.logLevel] ?? levels.info;

/**
 * Structured JSON logger
 */
export const logger = {
  _log(level, message, data = {}) {
    if (levels[level] > currentLevel) return;

    // Mask any tokens in data
    const safeData = { ...data };
    for (const key of Object.keys(safeData)) {
      if (key.toLowerCase().includes('token') && typeof safeData[key] === 'string') {
        safeData[key] = maskToken(safeData[key]);
      }
    }

    const entry = {
      time: new Date().toISOString(),
      level,
      msg: message,
      ...safeData
    };

    console.log(JSON.stringify(entry));
  },

  error(message, data) { this._log('error', message, data); },
  warn(message, data) { this._log('warn', message, data); },
  info(message, data) { this._log('info', message, data); },
  debug(message, data) { this._log('debug', message, data); }
};
