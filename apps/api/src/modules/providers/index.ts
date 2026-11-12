import { z } from 'zod';

export type CredentialField = { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'password' | 'select'; placeholder?: string; help?: string; options?: { value: string; label: string }[] };
export type ProviderCategory = 'lead_source' | 'telephony' | 'messaging' | 'payments' | 'productivity';
export type ProviderAuth = 'webhook_only' | 'credentials';

/** Services an adapter may use during a connection test (kept minimal so adapters stay plain modules). */
export type ProviderDeps = { verifySmtp: (cfg: Record<string, unknown>) => Promise<void> };

/**
 * One integration provider. `test` must talk to the real service and resolve with a short human summary
 * ("Account Acme Ltd, balance ₹1,200") or throw with the provider's own message; the integration becomes
 * CONNECTED only when it resolves. `secretKeys` are never returned to the browser.
 */
export interface ProviderDef {
  key: string;
  name: string;
  category: ProviderCategory;
  auth: ProviderAuth;
  description: string;
  /** What the customer must have before connecting. Shown in the UI so nothing looks connectable when it is not. */
  needs: string;
  credentialSchema: CredentialField[];
  credentials: z.ZodTypeAny;
  secretKeys: string[];
  /** Which hooks path the provider's webhooks arrive on, if any. */
  webhook?: { path: string; note: string };
  test?: (creds: Record<string, unknown>, deps: ProviderDeps) => Promise<string>;
}

/** Fetch with a timeout and a readable error for provider calls. */
export async function providerFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) }).catch((e) => {
    throw new Error((e as Error).name === 'TimeoutError' ? 'The provider did not answer within 15 seconds' : `Could not reach the provider: ${(e as Error).message}`);
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body, text };
}

export function providerError(res: Response, body: any, fallback: string): Error {
  const message = body?.error?.description ?? body?.error?.message ?? body?.message ?? body?.RestException?.Message ?? (typeof body === 'string' && body.length < 200 ? body : null);
  return new Error(`${fallback} (HTTP ${res.status}${message ? `: ${message}` : ''})`);
}

export const basicAuth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
