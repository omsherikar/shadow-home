/**
 * A browser request sent from another site. Browsers send `Origin` with every cross-site POST,
 * so a page elsewhere (or another machine's browser on the same Wi-Fi) could otherwise talk to
 * the house or reset the demo. Requests without `Origin` (curl, server to server) pass. Behind a
 * proxy (Amplify Hosting), the site's own host arrives as `X-Forwarded-Host`; a page elsewhere
 * can't set that header on a request the browser sends without asking first.
 */
export function fromOtherSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export const OTHER_SITE = () =>
  Response.json({ error: 'Requests from other sites are refused' }, { status: 403 });
