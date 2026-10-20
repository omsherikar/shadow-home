import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { log, traceOf, withRequest } from './log.ts';

const TRACE = '105445aa7843bc8bf206b12000100000';
const headers = (value?: string) =>
  new Headers(value === undefined ? {} : { 'x-cloud-trace-context': value });

describe('a log line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.K_SERVICE;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  test('on Cloud Run: one JSON line with severity, message and the trace', () => {
    process.env.K_SERVICE = 'shadow-home-host';
    process.env.GOOGLE_CLOUD_PROJECT = 'shadow-home-demo';
    const out = vi.spyOn(console, 'error').mockImplementation(() => {});
    log(
      'ERROR',
      'turn failed',
      { error: 'APIConnectionTimeoutError', ms: 20_012 },
      headers(`${TRACE}/1;o=1`),
    );
    expect(JSON.parse(out.mock.calls[0]?.[0] as string)).toEqual({
      severity: 'ERROR',
      message: 'turn failed',
      error: 'APIConnectionTimeoutError',
      ms: 20_012,
      'logging.googleapis.com/trace': `projects/shadow-home-demo/traces/${TRACE}`,
    });
  });

  test("the request's trace reaches lines logged anywhere inside it", () => {
    process.env.K_SERVICE = 'shadow-home-mcp';
    process.env.GOOGLE_CLOUD_PROJECT = 'p';
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    withRequest(headers(TRACE), () => log('INFO', 'ready'));
    expect(JSON.parse(out.mock.calls[0]?.[0] as string)).toMatchObject({
      'logging.googleapis.com/trace': `projects/p/traces/${TRACE}`,
    });
  });

  test('elsewhere: a readable line, as before', () => {
    const out = vi.spyOn(console, 'error').mockImplementation(() => {});
    log('ERROR', 'speak failed', { error: 'Error', reason: 'ElevenLabs answered 401' });
    expect(out).toHaveBeenCalledWith('speak failed (error=Error reason=ElevenLabs answered 401)');
  });

  test('no trace without a project, or from a header that is not one', () => {
    expect(traceOf(headers(TRACE), undefined)).toEqual({});
    expect(traceOf(headers('not-a-trace/1;o=1'), 'p')).toEqual({});
    expect(traceOf(headers(`${TRACE}x`), 'p')).toEqual({});
    expect(traceOf(undefined, 'p')).toEqual({});
  });
});

test("the server's copy is the same file", () => {
  const copy = (pkg: string) =>
    readFileSync(join(import.meta.dirname, `../../${pkg}/src/log.ts`), 'utf8');
  expect(copy('host')).toBe(copy('server'));
});
