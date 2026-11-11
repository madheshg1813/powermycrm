'use client';
import { Copy, Mail, Plus, ShieldCheck, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar, EmptyState, ErrorState, Field, Modal, PageHeader, Skeleton, Spinner, Tabs, useUi } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { Member, useRefs } from '@/lib/refs';

type Role = { id: string; name: string; systemKey: string | null; scope: 'OWN' | 'TEAM' | 'ALL'; permissions: string[]; users: number };
type Team = { id: string; name: string; members: number };
type Invitation = { id: string; email: string; role: string; expiresAt: string; expired: boolean };
type Permission = { key: string; group: string; label: string };
const SCOPE: Record<string, string> = { OWN: 'Own records only', TEAM: 'Own and team records', ALL: 'All records' };

export default function TeamPage() {
  const { me, can } = useAuth();
  const { reload: reloadRefs } = useRefs();
  const { toast, confirm } = useUi();
  const manage = can('users.manage');
  const manageRoles = can('roles.manage');
  const [tab, setTab] = useState<'users' | 'teams' | 'roles'>('users');
  const users = useApi<Member[]>('/users');
  const roles = useApi<Role[]>('/roles');
  const teams = useApi<Team[]>('/teams');
  const invitations = useApi<Invitation[]>(manage ? '/invitations' : null);
  const permissions = useApi<Permission[]>('/permissions');
  const [invite, setInvite] = useState(false);
  const [roleForm, setRoleForm] = useState<{ open: boolean; role: Role | null }>({ open: false, role: null });
  const [teamName, setTeamName] = useState('');

  const refresh = () => { users.reload(); roles.reload(); teams.reload(); invitations.reload(); reloadRefs(); };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const updateUser = (m: Member, body: Record<string, unknown>, ok: string) => run(() => api(`/users/${m.membershipId}`, { method: 'PATCH', body }), ok);
  const toggleActive = async (m: Member) => {
    if (m.status === 'ACTIVE' && !(await confirm({ title: `Deactivate ${m.name}?`, text: 'They are signed out at once and can no longer log in to this workspace. Their leads and history are kept.', confirmLabel: 'Deactivate', danger: true }))) return;
    updateUser(m, { status: m.status === 'ACTIVE' ? 'DEACTIVATED' : 'ACTIVE' }, m.status === 'ACTIVE' ? 'User deactivated' : 'User reactivated');
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Team"
        subtitle={users.data ? `${users.data.filter((u) => u.status === 'ACTIVE').length} active users` : undefined}
        actions={manage ? <button className="btn-primary" onClick={() => setInvite(true)}><UserPlus className="h-4 w-4" />Invite user</button> : undefined}
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Users', count: users.data?.length }, { value: 'teams', label: 'Teams', count: teams.data?.length }, { value: 'roles', label: 'Roles', count: roles.data?.length }]} />

      {tab === 'users' && (
        <>
          <div className="card mt-4 overflow-hidden">
            {users.error ? <ErrorState message={users.error.message} onRetry={users.reload} /> : !users.data ? <Skeleton /> : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th className="pl-5">User</th><th>Role</th><th>Team</th><th className="hidden sm:table-cell">Joined</th><th className="pr-5 text-right">Status</th></tr></thead>
                  <tbody>
                    {users.data.map((m) => {
                      const self = m.id === me?.user.id;
                      const locked = !manage || self || (m.role.systemKey === 'owner' && me?.role.systemKey !== 'owner');
                      return (
                        <tr key={m.membershipId}>
                          <td className="pl-5">
                            <span className="flex items-center gap-2.5"><Avatar name={m.name} />
                              <span className="min-w-0"><span className="block truncate font-semibold">{m.name}{self && <span className="font-normal text-ink-muted"> (you)</span>}</span><span className="block truncate text-[12.5px] text-ink-muted">{m.email}</span></span>
                            </span>
                          </td>
                          <td>
                            {locked ? m.role.name : (
                              <select className="input w-auto py-1.5" value={m.role.id} onChange={(e) => updateUser(m, { roleId: e.target.value }, 'Role updated')} aria-label={`Role for ${m.name}`}>
                                {roles.data?.filter((r) => r.systemKey !== 'owner' || me?.role.systemKey === 'owner').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                              </select>
                            )}
                          </td>
                          <td>
                            {!manage ? m.team?.name ?? <span className="text-ink-faint">&mdash;</span> : (
                              <select className="input w-auto py-1.5" value={m.team?.id ?? ''} onChange={(e) => updateUser(m, { teamId: e.target.value || null }, 'Team updated')} aria-label={`Team for ${m.name}`}>
                                <option value="">No team</option>
                                {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="hidden text-ink-muted sm:table-cell">{fmtDate(m.joinedAt)}</td>
                          <td className="pr-5 text-right">
                            <span className="inline-flex items-center gap-2">
                              <span className={m.status === 'ACTIVE' ? 'pill-green' : 'pill-muted'}>{m.status === 'ACTIVE' ? 'Active' : 'Deactivated'}</span>
                              {!locked && <button className="btn-ghost btn-sm" onClick={() => toggleActive(m)}>{m.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}</button>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {manage && !!invitations.data?.length && (
            <div className="card mt-5 overflow-hidden">
              <h2 className="card-title px-5 pt-4">Pending invitations</h2>
              <table className="table mt-2">
                <tbody>
                  {invitations.data.map((i) => (
                    <tr key={i.id}>
                      <td className="pl-5"><span className="flex items-center gap-2"><Mail className="h-4 w-4 text-ink-faint" />{i.email}</span></td>
                      <td>{i.role}</td>
                      <td className="text-ink-muted">{i.expired ? <span className="pill-amber">Expired</span> : `Expires ${fmtDate(i.expiresAt)}`}</td>
                      <td className="pr-5 text-right"><button className="btn-ghost btn-sm" onClick={() => run(() => api(`/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation cancelled')}>Cancel</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'teams' && (
        <div className="card mt-4">
          {manage && (
            <form className="flex gap-2 border-b border-ink/10 p-4" onSubmit={(e) => { e.preventDefault(); if (teamName.trim()) run(() => api('/teams', { body: { name: teamName } }).then(() => setTeamName('')), 'Team created'); }}>
              <input className="input max-w-xs" placeholder="New team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} aria-label="New team name" />
              <button className="btn-ink" disabled={!teamName.trim()}><Plus className="h-4 w-4" />Add team</button>
            </form>
          )}
          {teams.error ? <ErrorState message={teams.error.message} onRetry={teams.reload} /> : !teams.data ? <Skeleton rows={3} />
            : !teams.data.length ? <EmptyState icon={UsersRound} title="No teams yet" text="Teams group users so that managers with team scope see their team's leads and follow-ups." />
            : (
              <ul className="divide-y divide-ink/5">
                {teams.data.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span><span className="font-semibold">{t.name}</span><span className="ml-2 text-ink-muted">{t.members} member{t.members === 1 ? '' : 's'}</span></span>
                    {manage && <button className="btn-icon" aria-label={`Delete ${t.name}`} onClick={async () => { if (await confirm({ title: `Delete team ${t.name}?`, text: 'Its members stay in the workspace without a team.', confirmLabel: 'Delete', danger: true })) run(() => api(`/teams/${t.id}`, { method: 'DELETE' }), 'Team deleted'); }}><Trash2 className="h-4 w-4" /></button>}
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}

      {tab === 'roles' && (
        <div className="mt-4 space-y-3">
          {manageRoles && <div className="flex justify-end"><button className="btn-ghost" onClick={() => setRoleForm({ open: true, role: null })}><Plus className="h-4 w-4" />New role</button></div>}
          {roles.error ? <div className="card"><ErrorState message={roles.error.message} onRetry={roles.reload} /></div> : !roles.data ? <div className="card"><Skeleton rows={4} /></div> : roles.data.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-display font-bold"><ShieldCheck className="h-4 w-4 text-ink-muted" />{r.name}{r.systemKey && <span className="pill-muted font-sans">Built-in</span>}</p>
                <p className="mt-0.5 text-ink-muted">{SCOPE[r.scope]} · {r.permissions.length} of {permissions.data?.length ?? '…'} permissions · {r.users} user{r.users === 1 ? '' : 's'}</p>
              </div>
              {manageRoles && r.systemKey !== 'owner' && (
                <div className="flex gap-2">
                  <button className="btn-ghost btn-sm" onClick={() => setRoleForm({ open: true, role: r })}>Edit</button>
                  {!r.systemKey && <button className="btn-ghost btn-sm" onClick={async () => { if (await confirm({ title: `Delete role ${r.name}?`, confirmLabel: 'Delete', danger: true, text: 'This cannot be undone.' })) run(() => api(`/roles/${r.id}`, { method: 'DELETE' }), 'Role deleted'); }}>Delete</button>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <InviteModal open={invite} onClose={() => setInvite(false)} roles={roles.data ?? []} onDone={refresh} />
      <RoleModal open={roleForm.open} role={roleForm.role} permissions={permissions.data ?? []} onClose={() => setRoleForm({ open: false, role: null })} onDone={refresh} />
    </div>
  );
}

function InviteModal({ open, onClose, roles, onDone }: { open: boolean; onClose: () => void; roles: Role[]; onDone: () => void }) {
  const { me } = useAuth();
  const { toast } = useUi();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const options = roles.filter((r) => r.systemKey !== 'owner' || me?.role.systemKey === 'owner');

  useEffect(() => {
    if (open) { setEmail(''); setError(''); setLink(''); setRoleId(roles.find((r) => r.systemKey === 'agent')?.id ?? ''); }
  }, [open, roles]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ inviteUrl: string }>('/invitations', { body: { email, roleId } });
      setLink(r.inviteUrl);
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite a user"
      footer={link ? <button className="btn-ink" onClick={onClose}>Done</button> : <><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !email || !roleId} onClick={submit}>{busy && <Spinner />}Create invitation</button></>}>
      {link ? (
        <div>
          <p className="text-ink-soft">Invitation created for <strong>{email}</strong>. Email delivery is not connected yet, so send them this link yourself. It works once and expires in 7 days.</p>
          <div className="mt-3 flex gap-2">
            <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
            <button className="btn-ghost" onClick={async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }}><Copy className="h-4 w-4" />Copy</button>
          </div>
        </div>
      ) : (
        <form className="space-y-3.5" onSubmit={submit}>
          {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger" role="alert">{error}</p>}
          <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
          <Field label="Role">
            <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {options.map((r) => <option key={r.id} value={r.id}>{r.name} ({SCOPE[r.scope].toLowerCase()})</option>)}
            </select>
          </Field>
        </form>
      )}
    </Modal>
  );
}

function RoleModal({ open, onClose, role, permissions, onDone }: { open: boolean; onClose: () => void; role: Role | null; permissions: Permission[]; onDone: () => void }) {
  const { toast } = useUi();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Role['scope']>('OWN');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setName(role?.name ?? ''); setScope(role?.scope ?? 'OWN'); setPerms(new Set(role?.permissions ?? ['leads.view'])); setError(''); }
  }, [open, role]);

  const groups = [...new Set(permissions.map((p) => p.group))];
  const toggle = (k: string) => setPerms((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { ...(role?.systemKey ? {} : { name }), scope, permissions: [...perms] };
      await api(role ? `/roles/${role.id}` : '/roles', { method: role ? 'PATCH' : 'POST', body });
      toast(role ? 'Role updated' : 'Role created');
      onDone();
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={role ? `Edit ${role.name}` : 'New role'} wide
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || (!role?.systemKey && name.trim().length < 2)} onClick={save}>{busy && <Spinner />}Save role</button></>}>
      {error && <p className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-danger" role="alert">{error}</p>}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Role name" hint={role?.systemKey ? 'Built-in roles cannot be renamed' : undefined}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!!role?.systemKey} maxLength={60} />
        </Field>
        <Field label="Record access" hint="Which leads and follow-ups this role can see">
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value as Role['scope'])}>
            {Object.entries(SCOPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g}>
            <legend className="overline mb-2">{g}</legend>
            <div className="space-y-2">
              {permissions.filter((p) => p.group === g).map((p) => (
                <label key={p.key} className="flex cursor-pointer items-start gap-2.5">
                  <input type="checkbox" className="mt-0.5" checked={perms.has(p.key)} onChange={() => toggle(p.key)} />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}
