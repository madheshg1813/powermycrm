import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { PrismaService } from '../src/common/core';

let app: INestApplication;
let server: any;
const PW = 'correct-horse-42';
let n = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++n}`;

type Client = { token: string; agent: ReturnType<typeof request.agent>; get: (p: string) => request.Test; post: (p: string, b?: any) => request.Test; patch: (p: string, b?: any) => request.Test; del: (p: string) => request.Test };

function client(agent: ReturnType<typeof request.agent>, token: string): Client {
  const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
  return {
    token,
    agent,
    get: (p) => auth(agent.get(`/api/v1${p}`)),
    post: (p, b) => auth(agent.post(`/api/v1${p}`)).send(b ?? {}),
    patch: (p, b) => auth(agent.patch(`/api/v1${p}`)).send(b ?? {}),
    del: (p) => auth(agent.delete(`/api/v1${p}`)),
  };
}

async function registerOrg(name = 'Org') {
  const agent = request.agent(server);
  const email = `${uniq('owner')}@example.com`;
  const res = await agent.post('/api/v1/auth/register').send({ name: 'Owner One', email, password: PW, organisationName: uniq(name) });
  expect(res.status).toBe(201);
  return { ...client(agent, res.body.accessToken), email };
}

/** Invites a user with the named role into the owner's organisation and signs them in. */
async function addMember(owner: Client, roleName: string) {
  const roles = (await owner.get('/roles')).body as any[];
  const role = roles.find((r) => r.name === roleName);
  const email = `${uniq('member')}@example.com`;
  const inv = await owner.post('/invitations', { email, roleId: role.id });
  expect(inv.status).toBe(201);
  const token = inv.body.inviteUrl.split('/invite/')[1];
  const agent = request.agent(server);
  const acc = await agent.post(`/api/v1/auth/invitations/${token}/accept`).send({ name: `${roleName} User`, password: PW });
  expect(acc.status).toBe(201);
  const c = client(agent, acc.body.accessToken);
  const me = (await c.get('/auth/me')).body;
  return { ...c, email, userId: me.user.id as string };
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(mod.createNestApplication());
  await app.init();
  server = app.getHttpServer();
});
afterAll(async () => {
  await app.close();
});

describe('authentication', () => {
  it('rejects weak passwords and invalid emails', async () => {
    const r = await request(server).post('/api/v1/auth/register').send({ name: 'A B', email: 'nope', password: 'short', organisationName: 'X Co' });
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: any) => e.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('registers, seeds the organisation and returns the profile', async () => {
    const o = await registerOrg();
    const me = await o.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role.systemKey).toBe('owner');
    expect(me.body.permissions).toContain('leads.view');
    const pipelines = (await o.get('/pipelines')).body;
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].stages.map((s: any) => s.name)).toEqual(['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']);
    expect((await o.get('/roles')).body).toHaveLength(4);
  });

  it('refuses a second account with the same email', async () => {
    const o = await registerOrg();
    const r = await request(server).post('/api/v1/auth/register').send({ name: 'Dup', email: o.email, password: PW, organisationName: 'Other' });
    expect(r.status).toBe(409);
  });

  it('requires a token and rejects a forged one', async () => {
    expect((await request(server).get('/api/v1/leads')).status).toBe(401);
    expect((await request(server).get('/api/v1/leads').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
  });

  it('logs in, rejects a wrong password, and never stores the password in plaintext', async () => {
    const o = await registerOrg();
    expect((await request(server).post('/api/v1/auth/login').send({ email: o.email, password: 'wrong-password-1' })).status).toBe(401);
    const ok = await request(server).post('/api/v1/auth/login').send({ email: o.email, password: PW });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const agent = request.agent(server);
    const email = `${uniq('rot')}@example.com`;
    const reg = await agent.post('/api/v1/auth/register').send({ name: 'Rot Ate', email, password: PW, organisationName: 'Rot' });
    const firstCookie = reg.headers['set-cookie'][0].split(';')[0];

    const r1 = await agent.post('/api/v1/auth/refresh');
    expect(r1.status).toBe(200);
    // A retry with the previous cookie straight after rotation is tolerated (lost response)...
    const retry = await request(server).post('/api/v1/auth/refresh').set('Cookie', firstCookie);
    expect(retry.status).toBe(200);
    // ...but once the grace window has passed, replaying it must kill the session...
    await app.get(PrismaService).session.updateMany({ where: { user: { email } }, data: { lastUsedAt: new Date(Date.now() - 60_000) } });
    const replay = await request(server).post('/api/v1/auth/refresh').set('Cookie', firstCookie);
    expect(replay.status).toBe(401);
    // ...including for the legitimate holder of the newest cookie and access token.
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await request(server).get('/api/v1/auth/me').set('Authorization', `Bearer ${r1.body.accessToken}`)).status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const o = await registerOrg();
    expect((await o.agent.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await o.get('/auth/me')).status).toBe(401);
    expect((await o.agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('resets a password with a single-use token and signs out existing sessions', async () => {
    const o = await registerOrg();
    const f = await request(server).post('/api/v1/auth/forgot-password').send({ email: o.email });
    expect(f.status).toBe(200);
    const unknown = await request(server).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(unknown.body.token).toBeUndefined();
    const NEW = 'brand-new-pass-77';
    expect((await request(server).post('/api/v1/auth/reset-password').send({ token: f.body.token, password: NEW })).status).toBe(200);
    expect((await request(server).post('/api/v1/auth/reset-password').send({ token: f.body.token, password: NEW })).status).toBe(400);
    expect((await o.get('/auth/me')).status).toBe(401);
    expect((await request(server).post('/api/v1/auth/login').send({ email: o.email, password: PW })).status).toBe(401);
    expect((await request(server).post('/api/v1/auth/login').send({ email: o.email, password: NEW })).status).toBe(200);
  });
});

describe('tenant isolation', () => {
  let a: Awaited<ReturnType<typeof registerOrg>>, b: Awaited<ReturnType<typeof registerOrg>>;
  let leadA: any, stageA: string, sourceA: string, labelA: string, ownerA: string, taskA: string;

  beforeAll(async () => {
    a = await registerOrg('Alpha');
    b = await registerOrg('Beta');
    leadA = (await a.post('/leads', { name: 'Alpha Lead', phone: '9876500001' })).body;
    stageA = (await a.get('/pipelines')).body[0].stages[1].id;
    sourceA = (await a.get('/sources')).body[0].id;
    labelA = (await a.get('/labels')).body[0].id;
    ownerA = (await a.get('/auth/me')).body.user.id;
    taskA = (await a.post('/tasks', { title: 'Call back', dueAt: new Date().toISOString(), leadId: leadA.id })).body.id;
  });

  it('never lists another organisation’s data', async () => {
    expect((await b.get('/leads')).body.total).toBe(0);
    expect((await b.get('/leads?q=Alpha')).body.items).toHaveLength(0);
    expect((await b.get('/tasks?view=all&assignee=all')).body.total).toBe(0);
    expect((await b.get('/users')).body).toHaveLength(1);
    expect((await b.get('/dashboard')).body.leads.total).toBe(0);
    expect(await (await b.get('/leads/export')).text).not.toContain('Alpha Lead');
  });

  it('returns 404 for another organisation’s records by id', async () => {
    expect((await b.get(`/leads/${leadA.id}`)).status).toBe(404);
    expect((await b.patch(`/leads/${leadA.id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await b.get(`/leads/${leadA.id}/activities`)).status).toBe(404);
    expect((await b.post(`/leads/${leadA.id}/notes`, { body: 'x' })).status).toBe(404);
    expect((await b.del(`/leads/${leadA.id}`)).status).toBe(404);
    expect((await b.post('/leads/bulk', { ids: [leadA.id], action: 'archive' })).status).toBe(404);
    expect((await b.patch(`/tasks/${taskA}`, { status: 'DONE' })).status).toBe(404);
    expect((await b.del(`/tasks/${taskA}`)).status).toBe(404);
    expect((await b.patch(`/stages/${stageA}`, { name: 'Hacked' })).status).toBe(404);
    expect((await b.del(`/sources/${sourceA}`)).status).toBe(404);
    expect((await b.del(`/labels/${labelA}`)).status).toBe(404);
    expect((await a.get(`/leads/${leadA.id}`)).body.name).toBe('Alpha Lead');
  });

  it('refuses to attach another organisation’s stage, source, label, owner or lead', async () => {
    expect((await b.post('/leads', { name: 'X', stageId: stageA })).status).toBe(400);
    expect((await b.post('/leads', { name: 'X', sourceId: sourceA })).status).toBe(400);
    expect((await b.post('/leads', { name: 'X', labelIds: [labelA] })).status).toBe(400);
    expect((await b.post('/leads', { name: 'X', ownerId: ownerA })).status).toBe(400);
    expect((await b.post('/tasks', { title: 'T', dueAt: new Date().toISOString(), leadId: leadA.id })).status).toBe(400);
    const own = (await b.post('/leads', { name: 'Beta Lead' })).body;
    expect((await b.post(`/leads/${own.id}/merge`, { duplicateId: leadA.id })).status).toBe(404);
    expect((await b.post('/leads/bulk', { ids: [own.id], action: 'stage', value: stageA })).status).toBe(400);
  });

  it('does not treat a matching phone in another organisation as a duplicate', async () => {
    const r = await b.post('/leads', { name: 'Same Phone', phone: '9876500001' });
    expect(r.status).toBe(201);
  });

  it('does not let an invitation or role id from another organisation be used', async () => {
    const roleA = (await a.get('/roles')).body[1].id;
    expect((await b.post('/invitations', { email: 'x@example.com', roleId: roleA })).status).toBe(400);
    expect((await b.patch(`/roles/${roleA}`, { permissions: [] })).status).toBe(404);
  });
});

describe('roles and permissions', () => {
  let owner: Awaited<ReturnType<typeof registerOrg>>, agent: Awaited<ReturnType<typeof addMember>>, agent2: Awaited<ReturnType<typeof addMember>>, manager: Awaited<ReturnType<typeof addMember>>;
  let ownerLead: any, agentLead: any, agent2Lead: any;

  beforeAll(async () => {
    owner = await registerOrg('Perms');
    agent = await addMember(owner, 'Sales Agent');
    agent2 = await addMember(owner, 'Sales Agent');
    manager = await addMember(owner, 'Manager');
    ownerLead = (await owner.post('/leads', { name: 'Owner Lead' })).body;
    agentLead = (await agent.post('/leads', { name: 'Agent Lead' })).body;
    agent2Lead = (await agent2.post('/leads', { name: 'Agent Two Lead' })).body;
  });

  it('limits an agent to their own leads', async () => {
    const list = (await agent.get('/leads')).body;
    expect(list.items.map((l: any) => l.name)).toEqual(['Agent Lead']);
    expect((await agent.get(`/leads/${ownerLead.id}`)).status).toBe(404);
    expect((await agent.patch(`/leads/${agent2Lead.id}`, { name: 'Nope' })).status).toBe(404);
    expect((await owner.get('/leads')).body.total).toBe(3);
  });

  it('blocks actions the role does not grant', async () => {
    expect((await agent.get('/leads/export')).status).toBe(403);
    expect((await agent.post('/leads/import', { rows: [{ name: 'A' }] })).status).toBe(403);
    expect((await agent.post('/leads/bulk', { ids: [agentLead.id], action: 'archive' })).status).toBe(403);
    expect((await agent.patch(`/leads/${agentLead.id}`, { ownerId: agent2.userId })).status).toBe(403);
    expect((await agent.post('/leads', { name: 'Give away', ownerId: agent2.userId })).status).toBe(403);
    expect((await agent.post('/sources', { name: 'New source' })).status).toBe(403);
    expect((await agent.post('/invitations', { email: 'a@example.com', roleId: 'x' })).status).toBe(403);
    expect((await agent.patch('/organisation', { name: 'Renamed' })).status).toBe(403);
    expect((await agent.get('/dashboard')).status).toBe(403);
    expect((await agent.get('/audit-log')).status).toBe(403);
    expect((await agent.get('/tasks?assignee=all&view=all')).body.total).toBe(0);
  });

  it('hides colleague email addresses from users without users.view', async () => {
    expect((await agent.get('/users')).body[0].email).toBeUndefined();
    expect((await owner.get('/users')).body[0].email).toBeTruthy();
  });

  it('gives a manager team scope: own leads plus team members’', async () => {
    expect((await manager.get('/leads')).body.total).toBe(0);
    const team = (await owner.post('/teams', { name: 'North' })).body;
    const users = (await owner.get('/users')).body as any[];
    const m = (id: string) => users.find((u) => u.id === id).membershipId;
    await owner.patch(`/users/${m(manager.userId)}`, { teamId: team.id });
    await owner.patch(`/users/${m(agent.userId)}`, { teamId: team.id });
    const names = (await manager.get('/leads')).body.items.map((l: any) => l.name);
    expect(names).toEqual(['Agent Lead']);
    expect((await manager.get(`/leads/${agent2Lead.id}`)).status).toBe(404);
    expect((await manager.patch(`/leads/${agentLead.id}`, { ownerId: manager.userId })).status).toBe(200);
  });

  it('applies custom role changes immediately', async () => {
    const role = (await owner.post('/roles', { name: 'Exporter', scope: 'OWN', permissions: ['leads.view', 'leads.export'] })).body;
    const users = (await owner.get('/users')).body as any[];
    await owner.patch(`/users/${users.find((u) => u.id === agent2.userId).membershipId}`, { roleId: role.id });
    expect((await agent2.get('/leads/export')).status).toBe(200);
    expect((await agent2.post('/leads', { name: 'No create' })).status).toBe(403);
    expect((await owner.post('/roles', { name: 'Bad', scope: 'OWN', permissions: ['root.everything'] })).status).toBe(400);
    expect((await owner.del(`/roles/${role.id}`)).status).toBe(400); // still has a user
  });

  it('protects the owner and blocks self-demotion', async () => {
    const users = (await owner.get('/users')).body as any[];
    const self = users.find((u) => u.role.systemKey === 'owner');
    expect((await owner.patch(`/users/${self.membershipId}`, { status: 'DEACTIVATED' })).status).toBe(400);
    const adminRole = (await owner.get('/roles')).body.find((r: any) => r.systemKey === 'admin');
    await owner.patch(`/users/${users.find((u) => u.id === manager.userId).membershipId}`, { roleId: adminRole.id });
    expect((await manager.patch(`/users/${self.membershipId}`, { status: 'DEACTIVATED' })).status).toBe(403);
    const ownerRole = (await owner.get('/roles')).body.find((r: any) => r.systemKey === 'owner');
    expect((await manager.patch(`/roles/${ownerRole.id}`, { permissions: [] })).status).toBe(400);
  });

  it('cuts off a deactivated user at once', async () => {
    const users = (await owner.get('/users')).body as any[];
    const r = await owner.patch(`/users/${users.find((u) => u.id === agent.userId).membershipId}`, { status: 'DEACTIVATED' });
    expect(r.status).toBe(200);
    expect((await agent.get('/leads')).status).toBe(401);
    expect((await agent.agent.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await request(server).post('/api/v1/auth/login').send({ email: agent.email, password: PW })).status).toBe(401);
  });
});

describe('leads', () => {
  let o: Awaited<ReturnType<typeof registerOrg>>, stages: any[], sources: any[], labels: any[];

  beforeAll(async () => {
    o = await registerOrg('Leads');
    stages = (await o.get('/pipelines')).body[0].stages;
    sources = (await o.get('/sources')).body;
    labels = (await o.get('/labels')).body;
  });

  it('creates a lead in the first stage, owned by the creator, with a timeline entry', async () => {
    const r = await o.post('/leads', { name: 'Asha Rao', phone: '+91 98765 43210', email: 'Asha@Example.com', sourceId: sources[0].id, labelIds: [labels[0].id], dealValue: 25000 });
    expect(r.status).toBe(201);
    expect(r.body.stage.name).toBe('New');
    expect(r.body.owner.name).toBe('Owner One');
    expect(r.body.email).toBe('asha@example.com');
    expect(r.body.phoneNormalized).toBe('9876543210');
    expect(r.body.dealValue).toBe(25000);
    expect(r.body.labels).toHaveLength(1);
    const acts = (await o.get(`/leads/${r.body.id}/activities`)).body;
    expect(acts.map((a: any) => a.type)).toEqual(['created']);
  });

  it('validates input', async () => {
    expect((await o.post('/leads', { name: '' })).status).toBe(400);
    expect((await o.post('/leads', { name: 'X', email: 'not-an-email' })).status).toBe(400);
    expect((await o.post('/leads', { name: 'X', dealValue: -5 })).status).toBe(400);
  });

  it('detects duplicates by phone format variants and by email, unless overridden', async () => {
    const dupPhone = await o.post('/leads', { name: 'Asha Again', phone: '09876543210' });
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.duplicates[0].name).toBe('Asha Rao');
    expect((await o.post('/leads', { name: 'Asha Mail', email: 'ASHA@example.com' })).status).toBe(409);
    expect((await o.post('/leads', { name: 'Asha Forced', phone: '9876543210', allowDuplicate: true })).status).toBe(201);
  });

  it('searches, filters, sorts and paginates', async () => {
    await o.post('/leads', { name: 'Bharat Traders', company: 'Bharat & Co', phone: '9000000001', sourceId: sources[1].id, score: 80 });
    await o.post('/leads', { name: 'Chitra Nair', phone: '9000000002', sourceId: sources[1].id, stageId: stages[2].id, score: 40 });
    expect((await o.get('/leads?q=bharat')).body.items.map((l: any) => l.name)).toEqual(['Bharat Traders']);
    expect((await o.get('/leads?q=90000 00002')).body.items.map((l: any) => l.name)).toEqual(['Chitra Nair']);
    expect((await o.get(`/leads?sourceId=${sources[1].id}`)).body.total).toBe(2);
    expect((await o.get(`/leads?stageId=${stages[2].id}`)).body.total).toBe(1);
    expect((await o.get(`/leads?labelId=${labels[0].id}`)).body.total).toBe(1);
    expect((await o.get('/leads?ownerId=unassigned')).body.total).toBe(0);
    const sorted = (await o.get('/leads?sort=score&dir=desc')).body.items;
    expect(sorted[0].name).toBe('Bharat Traders');
    const p1 = (await o.get('/leads?pageSize=2&page=1&sort=name&dir=asc')).body;
    const p2 = (await o.get('/leads?pageSize=2&page=2&sort=name&dir=asc')).body;
    expect(p1.total).toBe(4);
    expect(p1.items).toHaveLength(2);
    expect(p2.items[0].name).not.toBe(p1.items[0].name);
    expect((await o.get('/leads?sort=password')).status).toBe(400);
  });

  it('records stage changes, field changes and notes on the timeline', async () => {
    const lead = (await o.get('/leads?q=Bharat')).body.items[0];
    const u = await o.patch(`/leads/${lead.id}`, { stageId: stages[1].id, city: 'Chennai', dealValue: 50000 });
    expect(u.status).toBe(200);
    expect(u.body.stage.name).toBe('Contacted');
    await o.post(`/leads/${lead.id}/notes`, { body: 'Asked for a callback on Monday' });
    const acts = (await o.get(`/leads/${lead.id}/activities`)).body;
    const types = acts.map((a: any) => a.type);
    expect(types).toEqual(expect.arrayContaining(['created', 'stage_changed', 'updated', 'note']));
    const sc = acts.find((a: any) => a.type === 'stage_changed');
    expect(sc.data).toEqual({ from: 'New', to: 'Contacted' });
    expect(acts.find((a: any) => a.type === 'updated').data.changes.city).toEqual({ from: null, to: 'Chennai' });
  });

  it('assigns a lead and notifies the new owner', async () => {
    const agent = await addMember(o, 'Sales Agent');
    const lead = (await o.get('/leads?q=Chitra')).body.items[0];
    expect((await o.patch(`/leads/${lead.id}`, { ownerId: agent.userId })).status).toBe(200);
    const notes = (await agent.get('/notifications')).body;
    expect(notes.unread).toBe(1);
    expect(notes.items[0].link).toBe(`/leads/${lead.id}`);
    await agent.post('/notifications/read');
    expect((await agent.get('/notifications')).body.unread).toBe(0);
    expect((await agent.get('/leads')).body.total).toBe(1);
    expect((await o.get('/leads?ownerId=me')).body.total).toBe(3);
  });

  it('runs bulk actions and reports what it skipped', async () => {
    const all = (await o.get('/leads')).body.items;
    const ids = all.slice(0, 2).map((l: any) => l.id);
    const r = await o.post('/leads/bulk', { ids: [...ids, 'does-not-exist'], action: 'stage', value: stages[3].id });
    expect(r.body).toEqual({ updated: 2, skipped: 1 });
    expect((await o.get(`/leads?stageId=${stages[3].id}`)).body.total).toBe(2);
    await o.post('/leads/bulk', { ids, action: 'addLabel', value: labels[2].id });
    expect((await o.get(`/leads?labelId=${labels[2].id}`)).body.total).toBe(2);
    await o.post('/leads/bulk', { ids, action: 'archive' });
    expect((await o.get('/leads')).body.total).toBe(2);
    expect((await o.get('/leads?archived=true')).body.total).toBe(2);
    await o.post('/leads/bulk', { ids: [ids[0]], action: 'restore' });
    expect((await o.get('/leads')).body.total).toBe(3);
    // Permanent delete only works on an archived lead.
    expect((await o.del(`/leads/${ids[0]}`)).status).toBe(400);
    expect((await o.del(`/leads/${ids[1]}`)).status).toBe(200);
    expect((await o.get('/leads?archived=true')).body.total).toBe(0);
  });

  it('merges a duplicate into the primary lead', async () => {
    const p = (await o.post('/leads', { name: 'Deepak Primary', phone: '9111100000' })).body;
    const d = (await o.post('/leads', { name: 'Deepak Dup', phone: '9111100000', email: 'deepak@example.com', city: 'Pune', allowDuplicate: true })).body;
    await o.post(`/leads/${d.id}/notes`, { body: 'note on duplicate' });
    await o.post('/tasks', { title: 'Follow up dup', dueAt: new Date().toISOString(), leadId: d.id });
    expect((await o.get(`/leads/${p.id}`)).body.duplicates).toHaveLength(1);
    const m = await o.post(`/leads/${p.id}/merge`, { duplicateId: d.id });
    expect(m.status).toBe(200);
    expect(m.body.email).toBe('deepak@example.com');
    expect(m.body.city).toBe('Pune');
    expect(m.body.tasks).toHaveLength(1);
    expect(m.body.duplicates).toHaveLength(0);
    expect((await o.get(`/leads/${d.id}`)).status).toBe(404);
    const types = (await o.get(`/leads/${p.id}/activities`)).body.map((a: any) => a.type);
    expect(types).toEqual(expect.arrayContaining(['merged', 'note', 'task_created']));
  });

  it('imports rows with skip, update and create strategies and reports row errors', async () => {
    const before = (await o.get('/leads')).body.total;
    const rows = [
      { name: 'Import One', phone: '9222200001', source: 'Trade Fair', note: 'Met at stall 4', dealValue: '₹12,500' },
      { name: 'Import Two', email: 'two@example.com' },
      { name: 'Import One Again', phone: '+91-92222-00001' }, // duplicate inside the file
      { name: 'Deepak Existing', phone: '9111100000', city: 'Mumbai' }, // duplicate of an existing lead
      { name: 'Bad Email', email: 'nope' },
      { name: '', phone: '', email: '' },
    ];
    const r = await o.post('/leads/import', { rows });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 2, updated: 0, skipped: 2 });
    expect(r.body.errors.map((e: any) => e.row)).toEqual([5, 6]);
    expect((await o.get('/leads')).body.total).toBe(before + 2);
    expect((await o.get('/sources')).body.map((s: any) => s.name)).toContain('Trade Fair');
    const one = (await o.get('/leads?q=Import One')).body.items[0];
    expect(one.dealValue).toBe(12500);
    expect((await o.get(`/leads/${one.id}/activities`)).body.map((a: any) => a.type)).toEqual(expect.arrayContaining(['created', 'note']));

    const upd = await o.post('/leads/import', { rows: [{ name: 'Deepak Existing', phone: '9111100000', city: 'Mumbai' }], duplicateStrategy: 'update' });
    expect(upd.body).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect((await o.get('/leads?q=Deepak')).body.items[0].city).toBe('Mumbai');

    const cr = await o.post('/leads/import', { rows: [{ name: 'Deepak Third', phone: '9111100000' }], duplicateStrategy: 'create' });
    expect(cr.body.created).toBe(1);
  });

  it('exports the filtered list as CSV and neutralises formulas', async () => {
    await o.post('/leads', { name: '=HYPERLINK("http://evil")', company: 'Comma, Inc' });
    const csv = (await o.get('/leads/export')).text;
    expect(csv.split('\r\n')[0]).toContain('Name,Phone,Email');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"Comma, Inc"');
    const filtered = (await o.get('/leads/export?q=Import Two')).text;
    expect(filtered.trim().split('\r\n')).toHaveLength(2);
  });
});

describe('pipelines, sources and labels', () => {
  let o: Awaited<ReturnType<typeof registerOrg>>;
  beforeAll(async () => { o = await registerOrg('Catalog'); });

  it('adds, renames, reorders and deletes stages with guards', async () => {
    const p = (await o.get('/pipelines')).body[0];
    const s = await o.post(`/pipelines/${p.id}/stages`, { name: 'Site visit', color: '#0E7490' });
    expect(s.status).toBe(201);
    let stages = (await o.get('/pipelines')).body[0].stages;
    expect(stages.map((x: any) => x.name)).toEqual(['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Site visit', 'Won', 'Lost']);
    expect((await o.post(`/pipelines/${p.id}/stages`, { name: 'site VISIT' })).status).toBe(409);
    expect((await o.patch(`/stages/${s.body.id}`, { name: 'Visit done' })).status).toBe(200);

    const ids = stages.map((x: any) => x.id);
    const reordered = [ids[5], ...ids.slice(0, 5), ...ids.slice(6)];
    expect((await o.post(`/pipelines/${p.id}/stages/reorder`, { stageIds: reordered })).status).toBe(201);
    stages = (await o.get('/pipelines')).body[0].stages;
    expect(stages[0].name).toBe('Visit done');
    expect((await o.post(`/pipelines/${p.id}/stages/reorder`, { stageIds: ids.slice(1) })).status).toBe(400);

    const lead = (await o.post('/leads', { name: 'In stage', stageId: s.body.id })).body;
    expect((await o.del(`/stages/${s.body.id}`)).status).toBe(400);
    await o.patch(`/leads/${lead.id}`, { stageId: ids[0] });
    expect((await o.del(`/stages/${s.body.id}`)).status).toBe(200);
  });

  it('manages a second pipeline and its default flag', async () => {
    const p2 = (await o.post('/pipelines', { name: 'Renewals' })).body;
    expect(p2.stages).toHaveLength(3);
    expect((await o.del(`/pipelines/${p2.id}`)).status).toBe(200);
    const def = (await o.get('/pipelines')).body[0];
    expect((await o.del(`/pipelines/${def.id}`)).status).toBe(400);
  });

  it('creates, renames and deletes sources and labels, rejecting duplicates', async () => {
    const s = (await o.post('/sources', { name: 'Expo' })).body;
    expect((await o.post('/sources', { name: 'expo' })).status).toBe(409);
    expect((await o.patch(`/sources/${s.id}`, { name: 'Expo 2026' })).status).toBe(200);
    const lead = (await o.post('/leads', { name: 'From expo', sourceId: s.id })).body;
    expect((await o.del(`/sources/${s.id}`)).status).toBe(200);
    expect((await o.get(`/leads/${lead.id}`)).body.source).toBeNull();

    const l = await o.post('/labels', { name: 'VIP', color: '#168A4C' });
    expect(l.status).toBe(201);
    expect((await o.post('/labels', { name: 'X', color: 'red' })).status).toBe(400);
    expect((await o.del(`/labels/${l.body.id}`)).status).toBe(200);
  });
});

describe('tasks and follow-ups', () => {
  it('buckets tasks into today, overdue, upcoming and done, and logs them on the lead', async () => {
    const o = await registerOrg('Tasks');
    const lead = (await o.post('/leads', { name: 'Task Lead' })).body;
    const at = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
    const overdue = (await o.post('/tasks', { title: 'Overdue call', dueAt: at(-48), leadId: lead.id, type: 'CALLBACK' })).body;
    await o.post('/tasks', { title: 'Next week demo', dueAt: at(24 * 7), type: 'DEMO', priority: 'HIGH' });
    expect((await o.post('/tasks', { title: '', dueAt: at(1) })).status).toBe(400);
    expect((await o.post('/tasks', { title: 'No date' })).status).toBe(400);

    const od = (await o.get('/tasks?view=overdue')).body;
    expect(od.items.map((t: any) => t.title)).toEqual(['Overdue call']);
    expect(od.counts).toMatchObject({ overdue: 1, upcoming: 1 });
    expect((await o.get('/tasks?view=upcoming')).body.items[0].title).toBe('Next week demo');

    const done = await o.patch(`/tasks/${overdue.id}`, { status: 'DONE' });
    expect(done.body.completedAt).toBeTruthy();
    expect((await o.get('/tasks?view=overdue')).body.total).toBe(0);
    expect((await o.get('/tasks?view=done')).body.total).toBe(1);
    const types = (await o.get(`/leads/${lead.id}/activities`)).body.map((a: any) => a.type);
    expect(types).toEqual(expect.arrayContaining(['task_created', 'task_completed']));
    expect((await o.get('/dashboard')).body.tasks).toEqual({ today: 0, overdue: 0 });
  });

  it('lets an agent manage only their own tasks', async () => {
    const o = await registerOrg('TaskPerms');
    const agent = await addMember(o, 'Sales Agent');
    const ownerTask = (await o.post('/tasks', { title: 'Owner task', dueAt: new Date().toISOString() })).body;
    expect((await agent.patch(`/tasks/${ownerTask.id}`, { status: 'DONE' })).status).toBe(404);
    const ownerId = (await o.get('/auth/me')).body.user.id;
    expect((await agent.post('/tasks', { title: 'For owner', dueAt: new Date().toISOString(), assigneeId: ownerId })).status).toBe(403);
    const assigned = await o.post('/tasks', { title: 'For agent', dueAt: new Date().toISOString(), assigneeId: agent.userId });
    expect(assigned.status).toBe(201);
    expect((await agent.get('/tasks?view=all')).body.items.map((t: any) => t.title)).toEqual(['For agent']);
    expect((await agent.get('/notifications')).body.unread).toBe(1);
  });
});

describe('dashboard accuracy', () => {
  it('computes every figure from stored leads', async () => {
    const o = await registerOrg('Dash');
    const stages = (await o.get('/pipelines')).body[0].stages;
    const by = (name: string) => stages.find((s: any) => s.name === name).id;
    const src = (await o.get('/sources')).body;
    await o.post('/leads', { name: 'L1', dealValue: 1000, sourceId: src[0].id });
    await o.post('/leads', { name: 'L2', dealValue: 2000, stageId: by('Proposal'), sourceId: src[0].id });
    await o.post('/leads', { name: 'L3', dealValue: 5000, stageId: by('Won'), sourceId: src[1].id });
    await o.post('/leads', { name: 'L4', dealValue: 7000, stageId: by('Won') });
    await o.post('/leads', { name: 'L5', stageId: by('Lost') });
    await o.post('/leads', { name: 'L6', ownerId: null });
    const archived = (await o.post('/leads', { name: 'L7', dealValue: 99999, stageId: by('Won') })).body;
    await o.post('/leads/bulk', { ids: [archived.id], action: 'archive' });

    const d = (await o.get('/dashboard')).body;
    expect(d.leads).toEqual({ total: 6, new: 6, open: 3, won: 2, lost: 1, unassigned: 1 });
    expect(d.conversionRate).toBeCloseTo(2 / 3);
    expect(d.value).toEqual({ pipeline: 3000, won: 12000 });
    expect(d.byStage.find((s: any) => s.name === 'Won')).toMatchObject({ count: 2, value: 12000 });
    expect(d.bySource.find((s: any) => s.name === src[0].name).count).toBe(2);
    expect(d.bySource.find((s: any) => s.name === 'No source').count).toBe(3);
    expect(d.byOwner.find((x: any) => x.name === 'Owner One')).toMatchObject({ leads: 5, won: 2, wonValue: 12000 });
    expect(d.trend).toHaveLength(14);
    expect(d.trend[13].count).toBe(6);
  });
});

describe('custom lead fields', () => {
  let o: Awaited<ReturnType<typeof registerOrg>>;
  beforeAll(async () => { o = await registerOrg('Fields'); });

  it('defines fields with stable keys and validates definitions', async () => {
    const budget = await o.post('/custom-fields', { label: 'Budget (lakhs)', type: 'NUMBER' });
    expect(budget.status).toBe(201);
    expect(budget.body.key).toBe('budget_lakhs');
    expect((await o.post('/custom-fields', { label: 'budget (LAKHS)', type: 'TEXT' })).status).toBe(409);
    expect((await o.post('/custom-fields', { label: 'Property type', type: 'DROPDOWN' })).status).toBe(400);
    expect((await o.post('/custom-fields', { label: 'Property type', type: 'DROPDOWN', options: ['2 BHK', '3 BHK', 'Villa'], required: true })).status).toBe(201);
    expect((await o.post('/custom-fields', { label: 'Amenities', type: 'MULTI_SELECT', options: ['Pool', 'Gym', 'Parking'] })).status).toBe(201);
    expect((await o.post('/custom-fields', { label: 'Site visit on', type: 'DATE' })).status).toBe(201);
    expect((await o.post('/custom-fields', { label: 'Loan needed', type: 'CHECKBOX' })).status).toBe(201);
    expect((await o.post('/custom-fields', { label: 'Bad', type: 'COLOUR' })).status).toBe(400);
    expect((await o.get('/custom-fields')).body.map((f: any) => f.key)).toEqual(['budget_lakhs', 'property_type', 'amenities', 'site_visit_on', 'loan_needed']);
    const agent = await addMember(o, 'Sales Agent');
    expect((await agent.post('/custom-fields', { label: 'Nope', type: 'TEXT' })).status).toBe(403);
    expect((await agent.get('/custom-fields')).body).toHaveLength(5);
  });

  it('enforces required fields and value types on create', async () => {
    const missing = await o.post('/leads', { name: 'No type' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe('Property type is required');
    expect((await o.post('/leads', { name: 'Bad', customFields: { property_type: 'Castle' } })).status).toBe(400);
    expect((await o.post('/leads', { name: 'Bad', customFields: { property_type: 'Villa', budget_lakhs: 'lots' } })).status).toBe(400);
    const ok = await o.post('/leads', {
      name: 'Good', customFields: { property_type: 'villa', budget_lakhs: '85', amenities: ['gym', 'Pool'], site_visit_on: '2026-12-01', loan_needed: 'yes', unknown_key: 'ignored' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.customFields).toEqual({ property_type: 'Villa', budget_lakhs: 85, amenities: ['Gym', 'Pool'], site_visit_on: '2026-12-01', loan_needed: true });
  });

  it('updates values, logs the change and protects required fields', async () => {
    const lead = (await o.get('/leads?q=Good')).body.items[0];
    const u = await o.patch(`/leads/${lead.id}`, { customFields: { budget_lakhs: 90, amenities: [] } });
    expect(u.status).toBe(200);
    expect(u.body.customFields).toEqual({ property_type: 'Villa', budget_lakhs: 90, site_visit_on: '2026-12-01', loan_needed: true });
    const act = (await o.get(`/leads/${lead.id}/activities`)).body.find((a: any) => a.type === 'updated');
    expect(act.data.changes['Budget (lakhs)']).toEqual({ from: 85, to: 90 });
    expect((await o.patch(`/leads/${lead.id}`, { customFields: { property_type: '' } })).status).toBe(400);
    // Editing other fields never trips the required check.
    expect((await o.patch(`/leads/${lead.id}`, { city: 'Pune' })).status).toBe(200);
  });

  it('imports and exports custom field columns', async () => {
    const r = await o.post('/leads/import', {
      rows: [
        { name: 'Imp A', phone: '9333300001', cf_property_type: '3 BHK', cf_budget_lakhs: '1,20', cf_loan_needed: 'No' },
        { name: 'Imp B', phone: '9333300002', cf_property_type: 'Bungalow' },
      ],
    });
    expect(r.body.created).toBe(1);
    expect(r.body.errors[0]).toMatchObject({ row: 2 });
    const a = (await o.get('/leads?q=Imp A')).body.items[0];
    expect(a.customFields).toEqual({ property_type: '3 BHK', budget_lakhs: 120, loan_needed: false });
    const csv = (await o.get('/leads/export?q=Imp A')).text.split('\r\n');
    expect(csv[0]).toContain('Created,Budget (lakhs),Property type,Amenities,Site visit on,Loan needed');
    expect(csv[1].endsWith(',120,3 BHK,,,No')).toBe(true);
  });

  it('renames a field without losing values and removes values when the field is deleted', async () => {
    const fields = (await o.get('/custom-fields')).body;
    const budget = fields.find((f: any) => f.key === 'budget_lakhs');
    expect((await o.patch(`/custom-fields/${budget.id}`, { label: 'Budget' })).body.key).toBe('budget_lakhs');
    expect((await o.get('/leads?q=Good')).body.items[0].customFields.budget_lakhs).toBe(90);
    expect((await o.del(`/custom-fields/${budget.id}`)).status).toBe(200);
    expect((await o.get('/leads?q=Good')).body.items[0].customFields.budget_lakhs).toBeUndefined();
    const other = await registerOrg('FieldsOther');
    expect((await other.del(`/custom-fields/${fields[1].id}`)).status).toBe(404);
    expect((await other.get('/custom-fields')).body).toHaveLength(0);
  });
});

describe('saved views', () => {
  it('keeps private views private and shows shared ones to colleagues', async () => {
    const o = await registerOrg('Views');
    const agent = await addMember(o, 'Sales Agent');
    const mine = await o.post('/saved-filters', { name: 'Hot Facebook', filters: { status: 'open', q: 'fb' } });
    expect(mine.status).toBe(201);
    const shared = (await o.post('/saved-filters', { name: 'Team won', shared: true, filters: { status: 'won' } })).body;
    expect((await o.post('/saved-filters', { name: '', filters: {} })).status).toBe(400);
    expect((await o.get('/saved-filters')).body.map((v: any) => v.name)).toEqual(['Hot Facebook', 'Team won']);
    const seen = (await agent.get('/saved-filters')).body;
    expect(seen).toEqual([{ id: shared.id, name: 'Team won', filters: { status: 'won' }, shared: true, mine: false }]);
    expect((await agent.del(`/saved-filters/${shared.id}`)).status).toBe(404);
    expect((await o.del(`/saved-filters/${mine.body.id}`)).status).toBe(200);
    const other = await registerOrg('ViewsOther');
    expect((await other.get('/saved-filters')).body).toHaveLength(0);
  });
});

describe('assignment rules', () => {
  it('distributes leads round-robin, prefers a source rule and skips deactivated users', async () => {
    const o = await registerOrg('Rules');
    const a = await addMember(o, 'Sales Agent');
    const b = await addMember(o, 'Sales Agent');
    const c = await addMember(o, 'Sales Agent');
    const sources = (await o.get('/sources')).body;
    const fb = sources.find((s: any) => s.name === 'Facebook').id;

    // With no rule, an auto-assigned lead stays unassigned.
    expect((await o.post('/leads', { name: 'No rule', ownerId: 'auto' })).body.owner).toBeNull();

    expect((await o.post('/assignment-rules', { name: 'Empty', userIds: [] })).status).toBe(400);
    expect((await o.post('/assignment-rules', { name: 'Bad user', userIds: ['nope'] })).status).toBe(400);
    const general = await o.post('/assignment-rules', { name: 'Everyone', userIds: [a.userId, b.userId] });
    expect(general.status).toBe(201);
    await o.post('/assignment-rules', { name: 'Facebook desk', sourceId: fb, userIds: [c.userId] });
    expect((await a.post('/assignment-rules', { name: 'X', userIds: [a.userId] })).status).toBe(403);

    const owners: string[] = [];
    for (const name of ['R1', 'R2', 'R3']) owners.push((await o.post('/leads', { name, ownerId: 'auto' })).body.owner.id);
    expect(owners).toEqual([a.userId, b.userId, a.userId]);
    expect((await o.post('/leads', { name: 'FB lead', ownerId: 'auto', sourceId: fb })).body.owner.id).toBe(c.userId);
    expect((await b.get('/notifications')).body.unread).toBe(1);

    // Import continues the same rotation (next is b) and routes Facebook rows to the Facebook rule.
    const imp = await o.post('/leads/import', {
      ownerId: 'auto',
      rows: [{ name: 'I1', phone: '9444400001' }, { name: 'I2', phone: '9444400002', source: 'Facebook' }, { name: 'I3', phone: '9444400003' }],
    });
    expect(imp.body.created).toBe(3);
    const ownerOf = async (q: string) => (await o.get(`/leads?q=${q}`)).body.items[0].owner.id;
    expect([await ownerOf('I1'), await ownerOf('I2'), await ownerOf('I3')]).toEqual([b.userId, c.userId, a.userId]);

    // A deactivated user drops out of the rotation; a paused rule is ignored.
    const users = (await o.get('/users')).body as any[];
    await o.patch(`/users/${users.find((u) => u.id === a.userId).membershipId}`, { status: 'DEACTIVATED' });
    expect((await o.post('/leads', { name: 'After leave 1', ownerId: 'auto' })).body.owner.id).toBe(b.userId);
    expect((await o.post('/leads', { name: 'After leave 2', ownerId: 'auto' })).body.owner.id).toBe(b.userId);
    await o.patch(`/assignment-rules/${general.body.id}`, { active: false });
    expect((await o.post('/leads', { name: 'Paused', ownerId: 'auto' })).body.owner).toBeNull();

    const other = await registerOrg('RulesOther');
    expect((await other.patch(`/assignment-rules/${general.body.id}`, { active: true })).status).toBe(404);
    expect((await other.post('/assignment-rules', { name: 'Cross', userIds: [b.userId] })).status).toBe(400);
  });
});

describe('audit log', () => {
  it('records administrative actions with the actor', async () => {
    const o = await registerOrg('Audit');
    await o.patch('/organisation', { name: 'Audit Renamed', currency: 'usd' });
    expect((await o.get('/organisation')).body).toMatchObject({ name: 'Audit Renamed', currency: 'USD' });
    const log = (await o.get('/audit-log')).body;
    expect(log.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['organisation.created', 'organisation.updated']));
    expect(log.items[0].actor).toBe('Owner One');
  });
});
