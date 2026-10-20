import { AsyncLocalStorage } from 'node:async_hooks';

// packages/server/src/log.ts and packages/host/src/log.ts are the same file.

export type Severity = 'INFO' | 'WARNING' | 'ERROR';
/** What a line may carry besides its message: names, reasons, counts and timings. */
export type Fields = Record<string, string | number | boolean | undefined>;

const request = new AsyncLocalStorage<Headers>();

/** Run `fn` with the request's headers in reach of every line it logs, for the trace. */
export function withRequest<T>(headers: Headers, fn: () => T): T {
  return request.run(headers, fn);
}

/**
 * One event. On Cloud Run (K_SERVICE is set) it's one JSON line with the fields Cloud Logging
 * reads: `severity`, `message`, and the request's trace, which files the line under that request
 * in the log viewer (https://docs.cloud.google.com/run/docs/logging). Elsewhere it's a readable
 * line. Log names, reasons and timings; never keys, addresses or what people said.
 */
export function log(
  severity: Severity,
  message: string,
  fields: Fields = {},
  headers: Headers | undefined = request.getStore(),
): void {
  const write = severity === 'INFO' ? console.log : console.error;
  if (process.env.K_SERVICE) {
    write(JSON.stringify({ severity, message, ...fields, ...traceOf(headers) }));
    return;
  }
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  write(extra ? `${message} (${extra})` : message);
}

/**
 * The trace Cloud Logging links a line to: `X-Cloud-Trace-Context` is `TRACE_ID/SPAN_ID;o=OPTIONS`,
 * and the field is `projects/PROJECT/traces/TRACE_ID`. Only with a project (GOOGLE_CLOUD_PROJECT)
 * and a well-formed trace ID, since a client can send the header too.
 */
export function traceOf(
  headers: Headers | undefined,
  project = process.env.GOOGLE_CLOUD_PROJECT,
): Record<string, string> {
  const trace = /^([0-9a-f]{32})(?:\/|;|$)/i.exec(headers?.get('x-cloud-trace-context') ?? '')?.[1];
  if (!trace || !project) return {};
  return { 'logging.googleapis.com/trace': `projects/${project}/traces/${trace.toLowerCase()}` };
}
