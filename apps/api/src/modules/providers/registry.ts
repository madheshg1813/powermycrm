import { z } from 'zod';
import { exotel } from './exotel';
import { ProviderDef } from './index';
import { indiamart, justdial, metaLeads } from './leadsources';
import { razorpay } from './razorpay';
import { sms } from './sms';
import { smtp } from './smtp';
import { whatsapp } from './whatsapp';

const websiteForm: ProviderDef = {
  key: 'website_form',
  name: 'Website form',
  category: 'lead_source',
  auth: 'webhook_only',
  description: 'Post your website or landing-page form to a PowerMyCRM endpoint. Each submission becomes a lead, de-duplicated and auto-assigned by your rules.',
  needs: 'Nothing external: add the endpoint and token to your form.',
  credentialSchema: [],
  credentials: z.object({}),
  secretKeys: ['token'],
};

/** Every provider the product can connect. Order is the order shown in Settings. */
export const PROVIDERS: ProviderDef[] = [websiteForm, smtp, whatsapp, sms, razorpay, exotel, metaLeads, indiamart, justdial];
export const providerByKey = (key: string) => PROVIDERS.find((p) => p.key === key);
export const PROVIDER_KEYS = PROVIDERS.map((p) => p.key) as [string, ...string[]];
