/**
 * A browser request sent from another site. Browsers send `Origin` with every cross-site POST,
 * so a page elsewhere (or another machine's browser on the same Wi-Fi) could otherwise talk to
 * the house or reset the demo. Requests without `Origin` (curl, server to server) pass.
 */
export function fromOtherSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}

export const OTHER_SITE = () =>
  Response.json({ error: 'Requests from other sites are refused' }, { status: 403 });
