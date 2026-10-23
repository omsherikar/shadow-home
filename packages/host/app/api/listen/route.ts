import { listen, listenReady } from '@/listen.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Whether the page should send its recordings here. */
export function GET(): Response {
  return listenReady();
}

/** One recording in, its words out (src/listen.ts). */
export function POST(request: Request): Promise<Response> {
  return listen(request);
}
