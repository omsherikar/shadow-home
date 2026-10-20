/**
 * What the device page may load and run.
 * - Scripts: Next's App Router writes inline bootstrap scripts into every page, with each page's
 *   own data in them, so a hash can't cover them. A nonce would need middleware to make one per
 *   request (Next reads it from the request's policy), and the plan view's frames would need it
 *   too, so inline scripts are allowed instead.
 * - The plan view runs in srcdoc frames, which take this policy on top of their own (VIEW_CSP in
 *   screen/ScreenHost.ts): its inline scripts and styles and its data: images and fonts must stay
 *   allowed here.
 * - The voice plays blob: audio. The 3D house draws with WebGL (no directive covers it), loads its
 *   models and lighting from /house/ on this origin, and turns glTF textures into blob: images,
 *   which three.js fetches in Chromium, so blob: is allowed for images and for fetches. Only this
 *   page can make a blob: URL it can read, so nothing leaves through it.
 * - In development Next also evaluates code and reloads over a websocket.
 */
export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' blob:${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The headers every response carries: the policy above, and no framing, sniffing or sensors. */
export function securityHeaders(dev: boolean): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(dev) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    // Speech recognition needs the microphone; nothing needs the camera or location.
    { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
  ];
}
