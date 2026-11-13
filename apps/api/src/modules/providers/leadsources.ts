import { z } from 'zod';
import { ProviderDef, providerError, providerFetch } from './index';
import { graphBase } from './whatsapp';

/** A lead in the shape every lead-source adapter produces; applyMapping's default mapping reads these keys. */
export type NormalizedLead = { name?: string; phone?: string; email?: string; company?: string; city?: string; message?: string; source: string } & Record<string, string | undefined>;
const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v).trim() || undefined);

// ---- IndiaMART (CRM pull API) ------------------------------------------------------------------------

export const indiamartBase = () => (process.env.INDIAMART_API_BASE ?? 'https://mapi.indiamart.com').replace(/\/$/, '');
export const indiamartCredentials = z.object({ crmKey: z.string().trim().min(10, 'Enter the IndiaMART CRM key') });

/** IndiaMART wants IST timestamps formatted as DD-Mon-YYYYHH:MM:SS. */
export function indiamartTime(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}-${g('month')}-${g('year')}${g('hour')}:${g('minute')}:${g('second')}`;
}

/** Pulls enquiries between two instants (IndiaMART allows at most 7 days per call and one call every 5 minutes). */
export async function pullIndiamart(crmKey: string, from: Date, to: Date): Promise<{ code: number; message: string; leads: { externalId: string; lead: NormalizedLead }[] }> {
  const url = `${indiamartBase()}/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(crmKey)}&start_time=${encodeURIComponent(indiamartTime(from))}&end_time=${encodeURIComponent(indiamartTime(to))}`;
  const { res, body } = await providerFetch(url);
  if (!res.ok) throw providerError(res, body, 'IndiaMART did not answer');
  const code = Number(body?.CODE ?? 0);
  const message = String(body?.MESSAGE ?? body?.STATUS ?? '');
  if (code !== 200 && code !== 204 && code !== 429) throw new Error(`IndiaMART refused the request (code ${code}${message ? `: ${message}` : ''})`);
  const leads = ((body?.RESPONSE ?? []) as Record<string, unknown>[]).map((r) => ({
    externalId: `im:${s(r.UNIQUE_QUERY_ID) ?? `${s(r.SENDER_MOBILE)}-${s(r.QUERY_TIME)}`}`,
    lead: {
      name: s(r.SENDER_NAME), phone: s(r.SENDER_MOBILE) ?? s(r.SENDER_MOBILE_ALT), email: s(r.SENDER_EMAIL) ?? s(r.SENDER_EMAIL_ALT), company: s(r.SENDER_COMPANY), city: s(r.SENDER_CITY),
      message: [s(r.SUBJECT), s(r.QUERY_PRODUCT_NAME) && `Product: ${s(r.QUERY_PRODUCT_NAME)}`, s(r.QUERY_MESSAGE)].filter(Boolean).join('\n') || undefined,
      source: 'IndiaMART',
    },
  }));
  return { code, message, leads };
}

export const indiamart: ProviderDef = {
  key: 'indiamart',
  name: 'IndiaMART',
  category: 'lead_source',
  auth: 'credentials',
  description: 'Every buyer enquiry on IndiaMART becomes a lead within about five minutes, de-duplicated and assigned by your rules.',
  needs: 'An IndiaMART seller account with Lead Manager access: generate the CRM key under Lead Manager → Import/Export Leads → Push/Pull API (CRM integration).',
  credentialSchema: [{ key: 'crmKey', label: 'CRM key', type: 'password' }],
  credentials: indiamartCredentials,
  secretKeys: ['crmKey'],
  async test(raw) {
    const c = indiamartCredentials.parse(raw);
    const now = new Date();
    const r = await pullIndiamart(c.crmKey, new Date(now.getTime() - 10 * 60_000), now);
    if (r.code === 429) return 'Key accepted (IndiaMART asks for at most one request every 5 minutes; the first pull runs shortly)';
    return `Key accepted; ${r.leads.length} enquir${r.leads.length === 1 ? 'y' : 'ies'} in the last 10 minutes`;
  },
};

// ---- Justdial (push to a URL) ----------------------------------------------------------------------------

/** Justdial posts (or GETs) these fields to the URL you give their team. */
export function normalizeJustdial(p: Record<string, unknown>): { externalId: string | null; lead: NormalizedLead } {
  const name = [s(p.prefix), s(p.name)].filter(Boolean).join(' ') || undefined;
  return {
    externalId: s(p.leadid) ? `jd:${s(p.leadid)}` : null,
    lead: {
      name, phone: s(p.mobile) ?? s(p.phone), email: s(p.email), company: s(p.company), city: s(p.city),
      message: [s(p.category) && `Category: ${s(p.category)}`, s(p.area) && `Area: ${s(p.area)}`, s(p.brancharea) && `Branch: ${s(p.brancharea)}`, s(p.date) && `Enquiry date: ${s(p.date)} ${s(p.time) ?? ''}`.trim()].filter(Boolean).join('\n') || undefined,
      source: 'Justdial',
    },
  };
}

export const justdial: ProviderDef = {
  key: 'justdial',
  name: 'Justdial',
  category: 'lead_source',
  auth: 'webhook_only',
  description: 'Justdial pushes each enquiry to a PowerMyCRM URL; it becomes a lead, de-duplicated and assigned by your rules.',
  needs: 'A Justdial paid listing. Send the URL shown after adding this integration to your Justdial account manager and ask them to push leads to it.',
  credentialSchema: [],
  credentials: z.object({}),
  secretKeys: ['token'],
  webhook: { path: 'justdial', note: 'Give this full URL (including the token) to your Justdial account manager; Justdial calls it for every new enquiry.' },
};

// ---- Meta lead ads (Facebook and Instagram forms) ---------------------------------------------------------------

const V = 'v21.0';
export const metaLeadsCredentials = z.object({
  pageId: z.string().trim().min(1, 'Enter the Facebook Page id'),
  pageAccessToken: z.string().trim().min(1, 'Enter the Page access token'),
  appSecret: z.string().trim().min(1, 'Enter the app secret'),
  verifyToken: z.string().trim().min(8, 'Choose a verify token of at least 8 characters'),
});
export type MetaLeadsCreds = z.infer<typeof metaLeadsCredentials>;

export const metaLeads: ProviderDef = {
  key: 'meta_leads',
  name: 'Facebook and Instagram lead ads',
  category: 'lead_source',
  auth: 'credentials',
  description: 'Leads from Facebook and Instagram lead-ad forms arrive in seconds through Meta\'s webhook, with every form answer kept on the lead.',
  needs: 'A Meta app (approved for leads_retrieval and pages_manage_metadata) subscribed to your Page\'s "leadgen" webhook at the URL shown after connecting, the Page id, a long-lived Page access token and the app secret.',
  credentialSchema: [
    { key: 'pageId', label: 'Facebook Page id', type: 'text' },
    { key: 'pageAccessToken', label: 'Page access token (long-lived)', type: 'password' },
    { key: 'appSecret', label: 'App secret', type: 'password', help: 'Used to verify webhook signatures' },
    { key: 'verifyToken', label: 'Webhook verify token', type: 'text', help: 'Any phrase; paste the same one into the Meta webhook settings' },
  ],
  credentials: metaLeadsCredentials,
  secretKeys: ['pageAccessToken', 'appSecret'],
  webhook: { path: 'meta_leads', note: 'In the Meta app, add this as the Page webhook callback URL with your verify token and subscribe to the "leadgen" field.' },
  async test(raw) {
    const c = metaLeadsCredentials.parse(raw);
    const { res, body } = await providerFetch(`${graphBase()}/${V}/${encodeURIComponent(c.pageId)}?fields=name&access_token=${encodeURIComponent(c.pageAccessToken)}`);
    if (!res.ok) throw providerError(res, body, 'Meta rejected the Page id or token');
    return `Connected to the Page "${body?.name ?? c.pageId}"`;
  },
};

/** Fetches a lead-ad submission and turns its form answers into lead fields; unknown answers go into the note. */
export async function fetchMetaLead(c: MetaLeadsCreds, leadgenId: string): Promise<NormalizedLead> {
  const { res, body } = await providerFetch(`${graphBase()}/${V}/${encodeURIComponent(leadgenId)}?fields=created_time,field_data,form_id,ad_name,campaign_name&access_token=${encodeURIComponent(c.pageAccessToken)}`);
  if (!res.ok) throw providerError(res, body, 'Could not fetch the lead from Meta');
  const answers = new Map<string, string>(((body?.field_data ?? []) as { name: string; values: string[] }[]).map((f) => [f.name.toLowerCase(), (f.values ?? []).join(', ')]));
  const take = (...keys: string[]) => { for (const k of keys) { const v = answers.get(k); if (v) { answers.delete(k); return v; } } return undefined; };
  const first = take('first_name'), last = take('last_name');
  const lead: NormalizedLead = {
    name: take('full_name', 'name') ?? ([first, last].filter(Boolean).join(' ') || undefined),
    phone: take('phone_number', 'phone', 'mobile_number'), email: take('email', 'work_email'), company: take('company_name', 'company'), city: take('city'),
    source: 'Facebook',
  };
  const extra = [...answers.entries()].map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  if (body?.campaign_name || body?.ad_name) extra.unshift(`Ad: ${[body.campaign_name, body.ad_name].filter(Boolean).join(' / ')}`);
  lead.message = extra.join('\n') || undefined;
  return lead;
}
