import { log } from './log.ts';

/**
 * Stop the way Cloud Run expects: on SIGTERM take no new requests, let those in flight finish,
 * then exit. Cloud Run stops the instance about 10 s after the signal, so whatever is still
 * running after `graceMs` (default 9 s) is cut off: a rule compile, at worst, which then never
 * adds its rule.
 */
export function stopGracefully(
  server: { close(done: () => void): unknown },
  options: {
    graceMs?: number;
    exit?: (code: number) => void;
    on?: (signal: 'SIGTERM', fn: () => void) => void;
  } = {},
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const on = options.on ?? ((signal, fn) => process.on(signal, fn));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    exit(0);
  };
  on('SIGTERM', () => {
    log('INFO', 'stopping');
    server.close(stop);
    setTimeout(stop, options.graceMs ?? 9_000).unref();
  });
}
