/**
 * Minimal leveled logger (stderr for warnings/errors, stdout otherwise). Never log secrets:
 * callers log paths (with `access_token` redacted), never upstream URLs with injected keys.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level: LogLevel = 'info', prefix = '[songdeck]'): Logger {
  const at = ORDER[level] ?? ORDER.info;
  const stamp = () => new Date().toISOString().slice(11, 23);
  return {
    debug: (m, ...a) => {
      if (at >= ORDER.debug) console.debug(`${stamp()} ${prefix} ${m}`, ...a);
    },
    info: (m, ...a) => {
      if (at >= ORDER.info) console.log(`${stamp()} ${prefix} ${m}`, ...a);
    },
    warn: (m, ...a) => {
      if (at >= ORDER.warn) console.warn(`${stamp()} ${prefix} ${m}`, ...a);
    },
    error: (m, ...a) => {
      if (at >= ORDER.error) console.error(`${stamp()} ${prefix} ${m}`, ...a);
    },
  };
}

export const silentLogger: Logger = createLogger('silent');
