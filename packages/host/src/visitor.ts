/** The key every request without a usable address shares (a local run, or a malformed header). */
const SHARED = 'local';

/**
 * Who is asking, as a key for per-visitor limits: the client's address from `X-Forwarded-For`.
 * Each proxy appends the address it received the request from, so the list runs from the client
 * to the nearest proxy (https://docs.cloud.google.com/functions/docs/reference/headers), and the
 * entries on the left are whatever the client sent, which it can forge. The one to trust is
 * counted from the right: `hops` (CLIENT_IP_HOPS, default 0) entries in from the end. Straight to
 * Cloud Run that's the rightmost, the address Google's front end saw. Behind a Google HTTPS load
 * balancer it's 1: the balancer appends the client and then its own address, and doesn't check
 * anything before them (https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header).
 * Next fills the header with the socket's address when it's missing, so a local run has one
 * visitor. Too few entries for the hops, or none, share one key, so a client can't choose its
 * own. The address is only ever a key; it's never logged.
 */
export function visitorOf(request: Request, hops = clientIpHops()): string {
  const entries = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const address = entries[entries.length - 1 - hops];
  return address ? networkOf(address) : SHARED;
}

/**
 * An IPv4 address as itself (also when written as IPv6); an IPv6 address as its /64, the block a
 * single home or server is usually given, so one visitor can't become many by changing the end.
 */
function networkOf(address: string): string {
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (v4) return v4[1] as string;
  if (!address.includes(':')) return address;
  const [head = '', tail] = address.replace(/%.*$/, '').toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros =
    tail === undefined ? [] : Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...zeros, ...right].slice(0, 4);
  return `${groups.map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function clientIpHops(): number {
  const raw = process.env.CLIENT_IP_HOPS;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : 0;
}
