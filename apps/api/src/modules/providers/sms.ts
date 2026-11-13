import { z } from 'zod';
import { ProviderDef, providerFetch } from './index';

/**
 * Generic HTTP SMS gateway. Every Indian and international gateway exposes a "send" URL; the customer pastes
 * theirs with {to}, {message} and {senderId} placeholders. Presets for common gateways are offered in the UI.
 */
export const smsCredentials = z.object({
  sendUrl: z.string().trim().url('Enter the gateway send URL').max(1000),
  method: z.enum(['GET', 'POST']).default('POST'),
  bodyTemplate: z.string().max(4000).default(''),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded']).default('application/json'),
  authHeaderName: z.string().trim().max(100).default(''),
  authHeaderValue: z.string().max(500).default(''),
  senderId: z.string().trim().max(20).default(''),
  successMatch: z.string().trim().max(100).default(''),
  testNumber: z.string().trim().min(6, 'Enter your own number for the test SMS').max(20),
});
export type SmsCreds = z.infer<typeof smsCredentials>;

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(to|message|senderId)\}/g, (_, k: string) => vars[k] ?? '');
const fillEncoded = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(to|message|senderId)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ''));
const fillJson = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(to|message|senderId)\}/g, (_, k: string) => JSON.stringify(vars[k] ?? '').slice(1, -1));

/** Sends one SMS through the configured gateway. Throws with the gateway's answer when it refuses. */
export async function sendSms(c: SmsCreds, to: string, message: string): Promise<{ response: string }> {
  const vars = { to, message, senderId: c.senderId };
  const headers: Record<string, string> = {};
  if (c.authHeaderName && c.authHeaderValue) headers[c.authHeaderName] = c.authHeaderValue;
  let url = c.sendUrl;
  let body: string | undefined;
  if (c.method === 'GET') url = fillEncoded(c.sendUrl, vars);
  else {
    url = fillEncoded(c.sendUrl, vars);
    headers['Content-Type'] = c.contentType;
    body = c.contentType === 'application/json' ? fillJson(c.bodyTemplate || '{"to":"{to}","message":"{message}","sender":"{senderId}"}', vars) : fill(c.bodyTemplate || 'to={to}&message={message}&sender={senderId}', vars).split('&').map((kv) => { const [k, ...v] = kv.split('='); return `${encodeURIComponent(k)}=${encodeURIComponent(v.join('='))}`; }).join('&');
  }
  const { res, text } = await providerFetch(url, { method: c.method, headers, body });
  if (!res.ok) throw new Error(`The SMS gateway answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  if (c.successMatch && !text.includes(c.successMatch)) throw new Error(`The gateway answered without "${c.successMatch}": ${text.slice(0, 200)}`);
  return { response: text.slice(0, 500) };
}

export const sms: ProviderDef = {
  key: 'sms_http',
  name: 'SMS gateway (HTTP)',
  category: 'messaging',
  auth: 'credentials',
  description: 'Send SMS to leads from the lead page and from automations through any gateway with an HTTP send API (MSG91, Twilio, Textlocal, Kaleyra…). Connecting sends one real test SMS to your own number.',
  needs: 'A gateway account with a send URL and credentials; in India also your DLT entity, sender id and approved templates. Replies are not received (one-way).',
  credentialSchema: [
    { key: 'sendUrl', label: 'Send URL', type: 'text', placeholder: 'https://api.msg91.com/api/sendhttp.php?authkey=…&mobiles={to}&message={message}&sender={senderId}&route=4&country=91&DLT_TE_ID=…', help: 'Use {to}, {message} and {senderId} where the gateway expects them' },
    { key: 'method', label: 'HTTP method', type: 'select', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }] },
    { key: 'contentType', label: 'POST body format', type: 'select', options: [{ value: 'application/json', label: 'JSON' }, { value: 'application/x-www-form-urlencoded', label: 'Form fields' }] },
    { key: 'bodyTemplate', label: 'POST body template', type: 'text', placeholder: '{"to":"{to}","message":"{message}","sender":"{senderId}"}  or  Body={message}&From={senderId}&To={to}' },
    { key: 'authHeaderName', label: 'Auth header name', type: 'text', placeholder: 'authkey  or  Authorization' },
    { key: 'authHeaderValue', label: 'Auth header value', type: 'password', placeholder: 'Basic …  or  the API key' },
    { key: 'senderId', label: 'Sender id', type: 'text', placeholder: 'ACMECO' },
    { key: 'successMatch', label: 'Text expected in a successful reply', type: 'text', placeholder: 'optional, e.g. "success"' },
    { key: 'testNumber', label: 'Your mobile number for the test SMS', type: 'text', placeholder: '919876543210' },
  ],
  credentials: smsCredentials,
  secretKeys: ['authHeaderValue'],
  async test(raw) {
    const c = smsCredentials.parse(raw);
    const r = await sendSms(c, c.testNumber, 'PowerMyCRM: your SMS gateway is connected.');
    return `Test SMS accepted by the gateway for ${c.testNumber}${r.response ? ` (${r.response.slice(0, 80)})` : ''}`;
  },
};
