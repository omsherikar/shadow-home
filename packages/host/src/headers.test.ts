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
});
