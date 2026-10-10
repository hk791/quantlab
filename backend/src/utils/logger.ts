/**
 * Minimal leveled logger standing in for Python's `logging.getLogger(__name__)`.
 * Keeps the module-name prefix so log output stays greppable the same way.
 */

type Level = 'debug' | 'info' | 'warning' | 'error'

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
}

const threshold =
  LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVEL_ORDER.info

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warning(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function getLogger(name: string): Logger {
  const emit = (level: Level, args: unknown[]) => {
    if (LEVEL_ORDER[level] < threshold) return
    const stamp = new Date().toISOString()
    const line = `${stamp} ${level.toUpperCase().padEnd(7)} ${name}:`
    if (level === 'error') console.error(line, ...args)
    else if (level === 'warning') console.warn(line, ...args)
    else console.log(line, ...args)
  }

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warning: (...a) => emit('warning', a),
    error: (...a) => emit('error', a),
  }
}
