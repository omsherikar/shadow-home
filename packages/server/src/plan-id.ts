import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A plan ID names one stored preview and binds it to the home's state version and an expiry:
 * `sh1.<payload>.<signature>`, where the payload is base64url JSON and the signature an
 * HMAC-SHA256 over it. Any edit to the payload breaks the signature.
 */
export interface PlanIdClaims {
  /** The stored preview's key. */
  n: string;
  /** Home state version the preview was checked against. */
  v: number;
  /** Wall-clock expiry, ms since the epoch. */
  x: number;
}

export type PlanIdCheck =
  | { ok: true; claims: PlanIdClaims }
  | { ok: false; reason: 'malformed' | 'tampered' | 'expired'; claims?: PlanIdClaims };

const PREFIX = 'sh1';

export function newNonce(): string {
  return randomBytes(12).toString('base64url');
}

export function signPlanId(secret: string, claims: PlanIdClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${PREFIX}.${payload}.${mac(secret, payload)}`;
}

export function verifyPlanId(secret: string, id: string, wallNowMs: number): PlanIdCheck {
  const parts = id.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'malformed' };
  const [, payload = '', sig = ''] = parts;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'tampered' };
  }
  let claims: PlanIdClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PlanIdClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims.n !== 'string' ||
    typeof claims.v !== 'number' ||
    typeof claims.x !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (wallNowMs > claims.x) return { ok: false, reason: 'expired', claims };
  return { ok: true, claims };
}

/**
 * Proof that an approval comes from the screen that showed the plan: an HMAC of the plan ID that
 * the server sends only in a result's `_meta`. The plan view reads it; the model reads
 * `structuredContent` and text, so it can't approve a plan in the person's place.
 */
export function approvalToken(secret: string, planId: string): string {
  return createHmac('sha256', secret).update(`approve:${planId}`).digest('base64url');
}

export function verifyApprovalToken(secret: string, planId: string, token: string): boolean {
  const expected = Buffer.from(approvalToken(secret, planId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest('base64url');
}
