import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const audio = () =>
  new Request('http://localhost/api/listen', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm;codecs=opus' },
    body: new Uint8Array([1, 2, 3, 4]),
  });

describe('/api/listen: speech to text with ElevenLabs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('ready only with a key, and never on a silent test run', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    let { listenReady: GET } = await import('./listen.ts');
    expect(await GET().json()).toEqual({ ready: false });
    vi.resetModules();
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    vi.stubEnv('SHADOW_HOME_SILENT', '');
    ({ listenReady: GET } = await import('./listen.ts'));
    expect(await GET().json()).toEqual({ ready: true });
  });

  test('sends the recording to ElevenLabs and returns its text', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    const fetch = vi.fn(async () => Response.json({ text: ' Turn off the living room lights. ' }));
    vi.stubGlobal('fetch', fetch);
    const { listen: POST } = await import('./listen.ts');
    const res = await POST(audio());
    expect(await res.json()).toEqual({ text: 'Turn off the living room lights.' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  test('no key, or ElevenLabs failing: 503, so the page uses the browser instead', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    let { listen: POST } = await import('./listen.ts');
    expect((await POST(audio())).status).toBe(503);
    vi.resetModules();
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    ({ listen: POST } = await import('./listen.ts'));
    expect((await POST(audio())).status).toBe(503);
  });

  test('refuses what is not a recording', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    const { listen: POST } = await import('./listen.ts');
    const text = new Request('http://localhost/api/listen', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect((await POST(text)).status).toBe(400);
  });

  test('a visitor past their hour gets 429', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    vi.stubEnv('LISTENS_PER_VISITOR_HOUR', '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ text: 'yes' })),
    );
    const { listen: POST } = await import('./listen.ts');
    expect((await POST(audio())).status).toBe(200);
    expect((await POST(audio())).status).toBe(429);
  });
});
