import { describe, expect, test } from 'vitest';
import { contentSecurityPolicy } from './headers.ts';
import { VIEW_CSP } from './screen/ScreenHost.ts';

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

  test("everything the plan view's own policy allows, the page's allows too", () => {
    // The view's srcdoc frame takes the page's policy on top of its own, so a source missing
    // here would stop the view's scripts, styles, images or fonts.
    const page = contentSecurityPolicy(false);
    for (const [directive, sources] of parse(VIEW_CSP)) {
      for (const source of sources.filter((s) => s !== "'none'")) {
        expect(sourcesFor(page, directive), `${directive} ${source}`).toContain(source);
      }
    }
  });

  test('the voice plays blob: audio, and the house reads blob: textures; workers stay possible', () => {
    const policy = contentSecurityPolicy(false);
    expect(sourcesFor(policy, 'media-src')).toEqual(["'self'", 'blob:']);
    expect(sourcesFor(policy, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(parse(policy).has('worker-src')).toBe(false);
  });
});
