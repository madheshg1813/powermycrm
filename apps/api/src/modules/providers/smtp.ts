import { z } from 'zod';
import { ProviderDef } from './index';

export const smtpCredentials = z.object({
  host: z.string().trim().min(1, 'Enter the SMTP host').max(200),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.coerce.boolean().default(false),
  user: z.string().trim().max(200).default(''),
  pass: z.string().max(500).default(''),
  from: z.string().trim().min(3, 'Enter the From address').max(200),
});

export const smtp: ProviderDef = {
  key: 'smtp',
  name: 'Email (SMTP)',
  category: 'messaging',
  auth: 'credentials',
  description: 'Send invitations, password resets, verification and automation emails from your own mail account or transactional email service.',
  needs: 'SMTP details from your email provider: Gmail (app password), Microsoft 365, Zoho, Amazon SES, SendGrid, Brevo…',
  credentialSchema: [
    { key: 'host', label: 'SMTP host', type: 'text', placeholder: 'smtp.gmail.com' },
    { key: 'port', label: 'Port', type: 'number', placeholder: '587' },
    { key: 'secure', label: 'Use implicit TLS (port 465)', type: 'boolean' },
    { key: 'user', label: 'Username', type: 'text', placeholder: 'you@yourcompany.com' },
    { key: 'pass', label: 'Password or app password', type: 'password' },
    { key: 'from', label: 'From address', type: 'text', placeholder: 'Sales Team <sales@yourcompany.com>' },
  ],
  credentials: smtpCredentials,
  secretKeys: ['pass'],
  async test(raw, deps) {
    const c = smtpCredentials.parse(raw);
    await deps.verifySmtp(c);
    return `Connected to ${c.host}:${c.port}${c.user ? ` as ${c.user}` : ''}`;
  },
};
