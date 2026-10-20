import { describe, expect, test } from 'vitest';
import { contentSecurityPolicy } from './headers.ts';

/** A policy as directive name -> its sources. */
function parse(policy: string): Map<string, string[]> {
  const directives = policy.split(';').map((d) => d.trim().split(/\s+/));
  return new Map(directives.map(([name = '', ...sources]) => [name, sources]));
}

/** The sources a fetch of this kind is checked against: its own directive, else default-src. */
function sourcesFor(policy: string, directive: string): string[] {
  const p = parse(policy);
  return p.get(directive) ?? p.get('default-src') ?? [];
}

describe('the content security policy', () => {
  test('in production, no code is evaluated from strings and no websocket opens', () => {
    const policy = contentSecurityPolicy(false);
    expect(sourcesFor(policy, 'script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(sourcesFor(policy, 'connect-src')).toEqual(["'self'", 'blob:']);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('ws:');
  });

  test("in development, Next's evaluated code and its reload websocket are allowed too", () => {
    const policy = contentSecurityPolicy(true);
    expect(sourcesFor(policy, 'script-src')).toContain("'unsafe-eval'");
    expect(sourcesFor(policy, 'connect-src')).toContain('ws:');
  });

  test.each([false, true])('the page is never framed and runs no plugins (dev: %s)', (dev) => {
    const policy = contentSecurityPolicy(dev);
    expect(sourcesFor(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(sourcesFor(policy, 'object-src')).toEqual(["'none'"]);
    expect(sourcesFor(policy, 'base-uri')).toEqual(["'self'"]);
    expect(sourcesFor(policy, 'form-action')).toEqual(["'self'"]);
    expect(sourcesFor(policy, 'default-src')).toEqual(["'self'"]);
  });
});
