import { z } from 'zod';
import { exotel } from './exotel';
import { ProviderDef } from './index';
import { razorpay } from './razorpay';
import { smtp } from './smtp';

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
export const PROVIDERS: ProviderDef[] = [websiteForm, smtp, razorpay, exotel];
export const providerByKey = (key: string) => PROVIDERS.find((p) => p.key === key);
export const PROVIDER_KEYS = PROVIDERS.map((p) => p.key) as [string, ...string[]];
