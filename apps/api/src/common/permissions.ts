export const PERMISSIONS = [
  { key: 'leads.view', group: 'Leads', label: 'View leads' },
  { key: 'leads.create', group: 'Leads', label: 'Create leads' },
  { key: 'leads.edit', group: 'Leads', label: 'Edit leads' },
  { key: 'leads.delete', group: 'Leads', label: 'Archive and delete leads' },
  { key: 'leads.assign', group: 'Leads', label: 'Assign and reassign leads' },
  { key: 'leads.import', group: 'Leads', label: 'Import leads' },
  { key: 'leads.export', group: 'Leads', label: 'Export leads' },
  { key: 'pipeline.manage', group: 'Sales', label: 'Manage pipelines, stages, sources and labels' },
  { key: 'tasks.manage', group: 'Follow-ups', label: 'View and manage other users’ tasks' },
  { key: 'reports.view', group: 'Reports', label: 'View dashboard and reports' },
  { key: 'users.view', group: 'Team', label: 'View users and teams' },
  { key: 'users.manage', group: 'Team', label: 'Invite, edit and deactivate users' },
  { key: 'roles.manage', group: 'Team', label: 'Manage roles and permissions' },
  { key: 'settings.manage', group: 'Settings', label: 'Manage organisation settings' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
export const ALL_PERMISSION_KEYS: string[] = PERMISSIONS.map((p) => p.key);

export const SYSTEM_ROLES: { systemKey: string; name: string; scope: 'OWN' | 'TEAM' | 'ALL'; permissions: string[] }[] = [
  { systemKey: 'owner', name: 'Owner', scope: 'ALL', permissions: ALL_PERMISSION_KEYS },
  { systemKey: 'admin', name: 'Admin', scope: 'ALL', permissions: ALL_PERMISSION_KEYS },
  {
    systemKey: 'manager',
    name: 'Manager',
    scope: 'TEAM',
    permissions: [
      'leads.view', 'leads.create', 'leads.edit', 'leads.assign', 'leads.import', 'leads.export',
      'tasks.manage', 'reports.view', 'users.view',
    ],
  },
  {
    systemKey: 'agent',
    name: 'Sales Agent',
    scope: 'OWN',
    permissions: ['leads.view', 'leads.create', 'leads.edit'],
  },
];

export const DEFAULT_STAGES: { name: string; color: string; type: 'OPEN' | 'WON' | 'LOST' }[] = [
  { name: 'New', color: '#2563EB', type: 'OPEN' },
  { name: 'Contacted', color: '#7C3AED', type: 'OPEN' },
  { name: 'Qualified', color: '#B54708', type: 'OPEN' },
  { name: 'Proposal', color: '#EA5A2A', type: 'OPEN' },
  { name: 'Negotiation', color: '#0E7490', type: 'OPEN' },
  { name: 'Won', color: '#168A4C', type: 'WON' },
  { name: 'Lost', color: '#B42318', type: 'LOST' },
];

export const DEFAULT_SOURCES = ['Website', 'Facebook', 'Google Ads', 'Referral', 'Walk-in', 'IndiaMART', 'Justdial', 'Import', 'Other'];
export const DEFAULT_LABELS = [
  { name: 'Hot', color: '#B42318' },
  { name: 'Warm', color: '#B54708' },
  { name: 'Cold', color: '#2563EB' },
];
