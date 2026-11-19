/* Minimal structured logger. One line per event, greppable, no dependencies. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  if (ORDER[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  (level === 'error' || level === 'warn' ? console.error : console.log)(line + tail);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', scope, msg, extra),
  };
}
export type Logger = ReturnType<typeof logger>;

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
