import { resetDemo } from '@/turn/demo-clock.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start the demo home over: the fixture's clock and state, nothing in the log. */
export async function POST(): Promise<Response> {
  if (process.env.DEMO_CLOCK !== '1')
    return Response.json({ error: 'Demo is off' }, { status: 404 });
  try {
    return Response.json({ homeNow: await resetDemo() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
