import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import * as http from 'http';
import request from 'supertest';
import { SMTPServer } from 'smtp-server';
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

describe('reports', () => {
  it('computes period summaries, the leaderboard, source and follow-up reports from stored records', async () => {
    const o = await registerOrg('Reports');
    const agent = await addMember(o, 'Sales Agent');
    const prisma = app.get(PrismaService);
    const stages = (await o.get('/pipelines')).body[0].stages;
    const by = (name: string) => stages.find((s: any) => s.name === name).id;
    const src = (await o.get('/sources')).body;
    const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
    const at = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

    const l1 = (await o.post('/leads', { name: 'R Open', dealValue: 1000, sourceId: src[0].id })).body;
    const l2 = (await o.post('/leads', { name: 'R Won', dealValue: 5000 })).body;
    await o.patch(`/leads/${l2.id}`, { stageId: by('Won') });
    const l3 = (await o.post('/leads', { name: 'R Lost' })).body;
    await o.patch(`/leads/${l3.id}`, { stageId: by('Lost') });
    const l4 = (await agent.post('/leads', { name: 'R Agent Won', dealValue: 2000 })).body;
    await agent.patch(`/leads/${l4.id}`, { stageId: by('Won') });
    const l5 = (await o.post('/leads', { name: 'R Old' })).body;
    await prisma.lead.update({ where: { id: l5.id }, data: { createdAt: new Date(Date.now() - 45 * 864e5) } });
    const archived = (await o.post('/leads', { name: 'R Archived', dealValue: 99999, stageId: by('Won') })).body;
    await o.post('/leads/bulk', { ids: [archived.id], action: 'archive' });
    await o.post(`/leads/${l1.id}/notes`, { body: 'Called, call again tomorrow' });
    await o.post('/tasks', { title: 'Overdue', dueAt: at(-24), leadId: l1.id });
    const t2 = (await o.post('/tasks', { title: 'Done early', dueAt: at(24) })).body;
    await o.patch(`/tasks/${t2.id}`, { status: 'DONE' });
    const t3 = (await o.post('/tasks', { title: 'Done late', dueAt: at(-48) })).body;
    await o.patch(`/tasks/${t3.id}`, { status: 'DONE' });

    // Wide range: the backdated lead counts; the archived lead never does.
    const wide = (await o.get(`/reports/summary?from=${day(-60)}&to=${day(1)}`)).body;
    expect(wide.totals).toMatchObject({ created: 5, won: 2, lost: 1, wonValue: 7000, openNow: 2 });
    expect(wide.totals.conversion).toBeCloseTo(2 / 3);
    expect(wide.range.timezone).toBe('Asia/Kolkata');

    const week = (await o.get(`/reports/summary?from=${day(-7)}&to=${day(1)}`)).body;
    expect(week.totals).toMatchObject({ created: 4, won: 2, lost: 1, wonValue: 7000 });
    expect(week.series).toHaveLength(9);
    const todayRow = week.series.find((s: any) => s.created === 4);
    expect(todayRow).toMatchObject({ won: 2, lost: 1, wonValue: 7000 });
    expect((await o.get(`/leads?createdFrom=${todayRow.fromAt}&createdTo=${todayRow.toAt}`)).body.total).toBe(4);
    const sum = (series: any[], k: string) => series.reduce((a, s) => a + s[k], 0);
    const hours = (await o.get(`/reports/summary?from=${day(-1)}&to=${day(1)}&unit=hour`)).body;
    expect(hours.series).toHaveLength(24);
    expect(sum(hours.series, 'created')).toBe(4);
    const months = (await o.get(`/reports/summary?from=${day(-60)}&to=${day(1)}&unit=month`)).body;
    expect(sum(months.series, 'created')).toBe(5);
    expect(sum((await o.get(`/reports/summary?from=${day(-60)}&to=${day(1)}&unit=week`)).body.series, 'won')).toBe(2);
    expect((await o.get(`/reports/summary?from=${day(-7)}&to=${day(1)}&sourceId=${src[0].id}`)).body.totals.created).toBe(1);
    expect((await o.get(`/reports/summary?from=${day(1)}&to=${day(-7)}`)).status).toBe(400);
    expect((await o.get('/reports/summary?unit=year')).status).toBe(400);
    expect((await o.get('/reports/summary?from=2020-01-01&to=2026-01-01')).status).toBe(400);

    const board = (await o.get(`/reports/agents?from=${day(-7)}&to=${day(1)}`)).body.rows;
    expect(board.map((r: any) => r.name)).toEqual(['Owner One', 'Sales Agent User']);
    expect(board[0]).toMatchObject({ created: 3, won: 1, lost: 1, wonValue: 5000, open: 2, tasksCompleted: 2, tasksOnTime: 1, tasksOverdue: 1, notes: 1 });
    expect(board[0].conversion).toBeCloseTo(0.5);
    expect(board[1]).toMatchObject({ created: 1, won: 1, lost: 0, wonValue: 2000, open: 0, tasksCompleted: 0 });

    const sources = (await o.get(`/reports/sources?from=${day(-7)}&to=${day(1)}`)).body.rows;
    expect(sources.find((s: any) => s.name === 'No source')).toMatchObject({ created: 3, won: 2, lost: 1, wonValue: 7000 });
    expect(sources.find((s: any) => s.id === src[0].id)).toMatchObject({ created: 1, won: 0, open: 1 });

    const fu = (await o.get(`/reports/follow-ups?from=${day(-7)}&to=${day(1)}`)).body;
    expect(fu.rows[0]).toMatchObject({ name: 'Owner One', due: 3, completed: 2, onTime: 1, overdue: 1, upcoming: 0 });
    expect(fu.totals.completed).toBe(2);
    expect(fu.byType).toEqual([{ type: 'FOLLOW_UP', due: 3, completed: 2, onTime: 1, cancelled: 0, overdue: 1, upcoming: 0 }]);

    // Drill-down filters on the lead list match the report's definitions.
    expect((await o.get(`/leads?status=won&closedFrom=${week.range.fromAt}&closedTo=${week.range.toAt}`)).body.total).toBe(2);
    expect((await o.get(`/leads?createdFrom=${week.range.fromAt}&createdTo=${week.range.toAt}`)).body.total).toBe(4);

    // CSV export of each report.
    const csv = (await o.get(`/reports/export?report=agents&from=${day(-7)}&to=${day(1)}`)).text.split('\r\n');
    expect(csv[0]).toContain('Agent,Leads created,Won,Lost,Won value');
    expect(csv[1].startsWith('Owner One,3,1,1,5000,2,50%,2,1,1,1')).toBe(true);
    expect((await o.get(`/reports/export?report=summary&unit=month&from=${day(-60)}&to=${day(1)}`)).text).toContain('Period,Leads created');
    expect((await o.get('/reports/export?report=nope')).status).toBe(400);

    // A scoped reporter only sees their own figures and cannot ask for someone else's.
    const role = (await o.post('/roles', { name: 'Scoped reporter', scope: 'OWN', permissions: ['leads.view', 'reports.view'] })).body;
    const users = (await o.get('/users')).body as any[];
    const ownerId = users.find((u) => u.role.systemKey === 'owner').id;
    await o.patch(`/users/${users.find((u) => u.id === agent.userId).membershipId}`, { roleId: role.id });
    expect((await agent.get(`/reports/summary?from=${day(-7)}&to=${day(1)}`)).body.totals).toMatchObject({ created: 1, won: 1, wonValue: 2000 });
    expect((await agent.get('/reports/agents')).body.rows.map((r: any) => r.name)).toEqual(['Sales Agent User']);
    expect((await agent.get(`/reports/summary?ownerId=${ownerId}`)).status).toBe(403);
    expect((await o.get(`/reports/summary?from=${day(-7)}&to=${day(1)}&ownerId=${agent.userId}`)).body.totals.created).toBe(1);

    const other = await registerOrg('ReportsOther');
    expect((await other.get(`/reports/summary?from=${day(-60)}&to=${day(1)}`)).body.totals).toMatchObject({ created: 0, won: 0, wonValue: 0 });
    expect((await other.get('/reports/agents')).body.rows).toHaveLength(1);
    expect((await other.get(`/reports/summary?sourceId=${src[0].id}`)).status).toBe(400);
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

  it('filters and sorts the lead list by custom field', async () => {
    await o.post('/custom-fields', { label: 'Area', type: 'TEXT' });
    await o.post('/leads', { name: 'Filt C', phone: '9333300003', customFields: { property_type: '2 BHK', budget_lakhs: 50, amenities: ['Pool'], site_visit_on: '2026-11-15', area: 'Anna Nagar' } });
    await o.post('/leads', { name: 'No budget', phone: '9333300004', customFields: { property_type: 'Villa' } });
    const names = async (q: string) => (await o.get(`/leads?${q}`)).body.items.map((l: any) => l.name);
    expect(await names('cf_property_type=villa&sort=name&dir=asc')).toEqual(['Good', 'No budget']);
    expect(await names('cf_property_type=Castle')).toEqual([]);
    expect(await names('cf_budget_lakhs_min=60&cf_budget_lakhs_max=100')).toEqual(['Good']);
    expect(await names('cf_budget_lakhs_min=100')).toEqual(['Imp A']);
    expect(await names('cf_budget_lakhs=50')).toEqual(['Filt C']);
    expect(await names('cf_loan_needed=false')).toEqual(['Imp A']);
    expect(await names('cf_amenities=pool')).toEqual(['Filt C']);
    expect(await names('cf_site_visit_on_from=2026-11-20')).toEqual(['Good']);
    expect(await names('cf_site_visit_on_to=2026-11-20')).toEqual(['Filt C']);
    expect(await names('cf_area=nagar')).toEqual(['Filt C']);
    expect(await names('cf_not_a_field=x&sort=name&dir=asc')).toHaveLength(4);
    expect(await names('sort=cf_budget_lakhs&dir=asc')).toEqual(['Filt C', 'Good', 'Imp A', 'No budget']);
    expect(await names('sort=cf_budget_lakhs&dir=desc')).toEqual(['Imp A', 'Good', 'Filt C', 'No budget']);
    // Equal values fall back to newest first, like the built-in sorts.
    expect(await names('sort=cf_property_type&dir=asc&pageSize=2&page=2')).toEqual(['No budget', 'Good']);
    expect((await o.get('/leads?sort=cf_budget_lakhs&dir=desc')).body.total).toBe(4);
    expect((await o.get('/leads?sort=cf_nope')).status).toBe(400);
    expect((await o.get('/leads/export?cf_property_type=2 BHK')).text.trim().split('\r\n')).toHaveLength(2);
    const agent = await addMember(o, 'Sales Agent');
    expect((await agent.get('/leads?cf_property_type=villa')).body.total).toBe(0);
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

describe('lead lists', () => {
  it('creates lists, adds and removes leads in bulk, filters by list and keeps leads when a list is deleted', async () => {
    const o = await registerOrg('Lists');
    const agent = await addMember(o, 'Sales Agent');
    const l1 = (await o.post('/leads', { name: 'List One', phone: '9555500001' })).body;
    const l2 = (await o.post('/leads', { name: 'List Two', phone: '9555500002' })).body;
    const l3 = (await agent.post('/leads', { name: 'Agent Lead', phone: '9555500003' })).body;

    const hot = await o.post('/lists', { name: 'Diwali campaign', description: 'Call before the 20th' });
    expect(hot.status).toBe(201);
    expect(hot.body).toMatchObject({ name: 'Diwali campaign', leads: 0, mine: true });
    expect((await o.post('/lists', { name: 'diwali CAMPAIGN' })).status).toBe(409);
    expect((await o.post('/lists', { name: '' })).status).toBe(400);

    // Add through the list endpoint and through the bulk action; duplicates and unknown ids are reported, not errors.
    const add = await o.post(`/lists/${hot.body.id}/leads`, { ids: [l1.id, l2.id, l1.id, 'nope'] });
    expect(add.body).toEqual({ added: 2, alreadyIn: 0, skipped: 1 });
    expect((await o.post(`/lists/${hot.body.id}/leads`, { ids: [l1.id] })).body).toEqual({ added: 0, alreadyIn: 1, skipped: 0 });
    expect((await o.post('/leads/bulk', { ids: [l3.id], action: 'addToList', value: hot.body.id })).body).toEqual({ updated: 1, skipped: 0 });
    expect((await o.post('/leads/bulk', { ids: [l3.id], action: 'addToList', value: 'nope' })).status).toBe(400);

    expect((await o.get(`/leads?listId=${hot.body.id}`)).body.items.map((l: any) => l.name).sort()).toEqual(['Agent Lead', 'List One', 'List Two']);
    expect((await o.get(`/leads/${l1.id}`)).body.lists).toEqual([{ id: hot.body.id, name: 'Diwali campaign' }]);
    expect((await o.get('/lists')).body[0].leads).toBe(3);

    // An agent only sees and touches their own leads in a list.
    expect((await agent.get('/lists')).body[0].leads).toBe(1);
    expect((await agent.get(`/leads?listId=${hot.body.id}`)).body.items.map((l: any) => l.name)).toEqual(['Agent Lead']);
    expect((await agent.post(`/lists/${hot.body.id}/leads`, { ids: [l1.id] })).status).toBe(404);
    expect((await agent.post(`/lists/${hot.body.id}/leads/remove`, { ids: [l1.id, l3.id] })).body).toEqual({ removed: 1, skipped: 1 });
    expect((await o.get('/lists')).body[0].leads).toBe(2);
    // The agent did not create the list, so cannot rename or delete it.
    expect((await agent.patch(`/lists/${hot.body.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await agent.del(`/lists/${hot.body.id}`)).status).toBe(403);
    const own = (await agent.post('/lists', { name: 'Agent list' })).body;
    expect((await agent.patch(`/lists/${own.id}`, { name: 'Agent calls' })).status).toBe(200);

    // Archived leads drop out of the count; bulk remove and delete leave the leads intact.
    await o.post('/leads/bulk', { ids: [l2.id], action: 'archive' });
    expect((await o.get('/lists')).body.find((l: any) => l.id === hot.body.id).leads).toBe(1);
    await o.post('/leads/bulk', { ids: [l1.id], action: 'removeFromList', value: hot.body.id });
    expect((await o.get(`/leads?listId=${hot.body.id}`)).body.total).toBe(0);
    expect((await o.patch(`/lists/${hot.body.id}`, { name: 'Agent calls' })).status).toBe(409);
    expect((await o.del(`/lists/${hot.body.id}`)).status).toBe(200);
    expect((await o.get(`/leads/${l1.id}`)).status).toBe(200);
    expect((await o.get('/lists')).body.map((l: any) => l.name)).toEqual(['Agent calls']);

    // Another organisation cannot see, use or change the list.
    const other = await registerOrg('ListsOther');
    expect((await other.get('/lists')).body).toHaveLength(0);
    expect((await other.get(`/leads?listId=${own.id}`)).body.total).toBe(0);
    expect((await other.post(`/lists/${own.id}/leads`, { ids: [l1.id] })).status).toBe(404);
    expect((await other.patch(`/lists/${own.id}`, { name: 'X' })).status).toBe(404);
    expect((await other.del(`/lists/${own.id}`)).status).toBe(404);
    const otherLead = (await other.post('/leads', { name: 'Other' })).body;
    expect((await other.post('/leads/bulk', { ids: [otherLead.id], action: 'addToList', value: own.id })).status).toBe(400);
  });
});

describe('attachments', () => {
  it('uploads, lists, downloads and deletes files on a lead within scope', async () => {
    const o = await registerOrg('Files');
    const agent = await addMember(o, 'Sales Agent');
    const lead = (await o.post('/leads', { name: 'Filed Lead', phone: '9123400001' })).body;
    const pdf = Buffer.from('%PDF-1.4\n%fake quote document\n%%EOF');
    const up = await o.agent.post(`/api/v1/leads/${lead.id}/attachments`).set('Authorization', `Bearer ${o.token}`).attach('file', pdf, 'Quote #12.pdf');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: 'Quote #12.pdf', mimeType: 'application/pdf', size: pdf.length, uploadedBy: { name: 'Owner One' } });
    expect((await o.agent.post(`/api/v1/leads/${lead.id}/attachments`).set('Authorization', `Bearer ${o.token}`).attach('file', Buffer.from('MZ'), 'virus.exe')).status).toBe(400);
    expect((await o.agent.post(`/api/v1/leads/${lead.id}/attachments`).set('Authorization', `Bearer ${o.token}`)).status).toBe(400);
    expect((await o.agent.post(`/api/v1/leads/${lead.id}/attachments`).set('Authorization', `Bearer ${o.token}`).attach('file', Buffer.alloc(11 * 1024 * 1024), 'big.pdf')).status).toBeGreaterThanOrEqual(400);
    const list = (await o.get(`/leads/${lead.id}/attachments`)).body;
    expect(list).toHaveLength(1);
    expect((await o.get(`/leads/${lead.id}`)).body.attachments).toHaveLength(1);
    const dl = await o.get(`/attachments/${up.body.id}/download`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(dl.body as Buffer, pdf)).toBe(0);
    expect((await o.get(`/leads/${lead.id}/activities`)).body.map((a: any) => a.type)).toContain('attachment_added');
    // The agent cannot see the owner's lead or its file; another workspace cannot either.
    expect((await agent.get(`/leads/${lead.id}/attachments`)).status).toBe(404);
    expect((await agent.get(`/attachments/${up.body.id}/download`)).status).toBe(404);
    expect((await agent.del(`/attachments/${up.body.id}`)).status).toBe(404);
    const other = await registerOrg('FilesOther');
    expect((await other.get(`/attachments/${up.body.id}/download`)).status).toBe(404);
    expect((await o.del(`/attachments/${up.body.id}`)).status).toBe(200);
    expect((await o.get(`/attachments/${up.body.id}/download`)).status).toBe(404);
    expect((await o.get(`/leads/${lead.id}/attachments`)).body).toHaveLength(0);
  });
});

describe('dynamic lists', () => {
  it('evaluates saved filters live and refuses manual membership changes', async () => {
    const o = await registerOrg('DynLists');
    const stages = (await o.get('/pipelines')).body[0].stages;
    const won = stages.find((s: any) => s.name === 'Won').id;
    const sources = (await o.get('/sources')).body;
    const l1 = (await o.post('/leads', { name: 'Dyn One', phone: '9321100001', sourceId: sources[0].id })).body;
    const l2 = (await o.post('/leads', { name: 'Dyn Two', phone: '9321100002', sourceId: sources[0].id, stageId: won })).body;
    await o.post('/leads', { name: 'Dyn Three', phone: '9321100003', sourceId: sources[1].id, stageId: won });
    expect((await o.post('/lists', { name: 'Empty rule', kind: 'DYNAMIC', filters: {} })).status).toBe(400);
    const dyn = await o.post('/lists', { name: 'Won from first source', kind: 'DYNAMIC', filters: { status: 'won', sourceId: sources[0].id } });
    expect(dyn.status).toBe(201);
    expect(dyn.body).toMatchObject({ kind: 'DYNAMIC', leads: 1 });
    expect((await o.get(`/leads?listId=${dyn.body.id}`)).body.items.map((l: any) => l.name)).toEqual(['Dyn Two']);
    // Membership follows the data: winning another lead adds it, no one has to maintain the list.
    await o.patch(`/leads/${l1.id}`, { stageId: won });
    expect((await o.get(`/leads?listId=${dyn.body.id}`)).body.total).toBe(2);
    expect((await o.get('/lists')).body.find((l: any) => l.id === dyn.body.id).leads).toBe(2);
    expect((await o.post(`/lists/${dyn.body.id}/leads`, { ids: [l2.id] })).status).toBe(400);
    expect((await o.post('/leads/bulk', { ids: [l2.id], action: 'addToList', value: dyn.body.id })).status).toBe(400);
    // Filters can be changed; a static list cannot be given filters; a dynamic list cannot nest another list.
    expect((await o.patch(`/lists/${dyn.body.id}`, { filters: { status: 'open' } })).status).toBe(200);
    expect((await o.get(`/leads?listId=${dyn.body.id}`)).body.items.map((l: any) => l.name)).toEqual([]);
    const stat = (await o.post('/lists', { name: 'Static one' })).body;
    expect((await o.patch(`/lists/${stat.id}`, { filters: { status: 'won' } })).status).toBe(400);
    await o.patch(`/lists/${dyn.body.id}`, { filters: { listId: stat.id } });
    expect((await o.get(`/leads?listId=${dyn.body.id}`)).body.total).toBe(3); // the nested listId is ignored, leaving no filter
  });
});

describe('call log', () => {
  it('logs calls with outcomes, creates the follow-up, feeds the leaderboard and respects scope', async () => {
    const o = await registerOrg('Calls');
    const agent = await addMember(o, 'Sales Agent');
    const lead = (await o.post('/leads', { name: 'Called Lead', phone: '9456700001' })).body;
    const agentLead = (await agent.post('/leads', { name: 'Agent Called', phone: '9456700002' })).body;
    const outcomes = (await o.get('/call-dispositions')).body;
    expect(outcomes.map((d: any) => d.name)).toContain('Call back later');
    const cb = outcomes.find((d: any) => d.name === 'Call back later').id;
    const tomorrow = new Date(Date.now() + 864e5).toISOString();
    const c1 = await o.post('/calls', { leadId: lead.id, status: 'COMPLETED', durationSec: 185, dispositionId: cb, notes: 'Wants a demo next week', followUp: { title: 'Call back about demo', dueAt: tomorrow } });
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ phone: '9456700001', direction: 'OUTBOUND', durationSec: 185, disposition: { name: 'Call back later' }, user: { name: 'Owner One' } });
    expect((await o.post('/calls', { leadId: lead.id, status: 'NO_ANSWER' })).body.durationSec).toBeNull();
    expect((await o.post('/calls', { status: 'COMPLETED' })).status).toBe(400); // no lead, no phone
    expect((await o.post('/calls', { phone: '9000000000', direction: 'INBOUND', durationSec: 30 })).status).toBe(201);
    expect((await o.post('/calls', { leadId: lead.id, dispositionId: 'nope' })).status).toBe(400);
    expect((await agent.post('/calls', { leadId: lead.id })).status).toBe(400); // not their lead
    await agent.post('/calls', { leadId: agentLead.id, durationSec: 60 });

    const acts = (await o.get(`/leads/${lead.id}/activities`)).body.map((a: any) => a.type);
    expect(acts).toEqual(expect.arrayContaining(['call_logged', 'task_created']));
    expect((await o.get(`/tasks?view=upcoming`)).body.items.map((t: any) => t.title)).toContain('Call back about demo');
    const all = (await o.get('/calls')).body;
    expect(all.total).toBe(4);
    expect(all.totals).toEqual({ calls: 4, talkTimeSec: 275 });
    expect((await o.get(`/calls?leadId=${lead.id}`)).body.total).toBe(2);
    expect((await o.get('/calls?status=NO_ANSWER')).body.total).toBe(1);
    expect((await agent.get('/calls')).body.items.map((c: any) => c.lead.name)).toEqual(['Agent Called']);
    expect((await agent.patch(`/calls/${c1.body.id}`, { notes: 'x' })).status).toBe(404);
    const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const board = (await o.get(`/reports/agents?from=${day(-1)}&to=${day(1)}`)).body.rows;
    expect(board.find((r: any) => r.name === 'Owner One')).toMatchObject({ calls: 3, talkTimeSec: 215 });
    expect((await o.get(`/reports/export?report=agents&from=${day(-1)}&to=${day(1)}`)).text).toContain('Calls,Talk time (sec)');
    // Outcomes are managed per workspace.
    const added = await o.post('/call-dispositions', { name: 'Price too high' });
    expect(added.status).toBe(201);
    expect((await o.post('/call-dispositions', { name: 'price TOO high' })).status).toBe(409);
    expect((await agent.post('/call-dispositions', { name: 'X' })).status).toBe(403);
    expect((await o.del(`/call-dispositions/${added.body.id}`)).status).toBe(200);
    const other = await registerOrg('CallsOther');
    expect((await other.get('/calls')).body.total).toBe(0);
    expect((await other.del(`/calls/${c1.body.id}`)).status).toBe(404);
  });
});

describe('automations', () => {
  it('runs steps when a trigger fires and conditions hold, waits and resumes, skips otherwise, and logs each run', async () => {
    const o = await registerOrg('Auto');
    const agent = await addMember(o, 'Sales Agent');
    const stages = (await o.get('/pipelines')).body[0].stages;
    const contacted = stages.find((s: any) => s.name === 'Contacted').id;
    const sources = (await o.get('/sources')).body;
    const fb = sources.find((s: any) => s.name === 'Facebook').id;
    const labels = (await o.get('/labels')).body;
    const hot = labels.find((l: any) => l.name === 'Hot').id;
    const list = (await o.post('/lists', { name: 'FB follow-ups' })).body;
    const options = (await o.get('/automations/options')).body;
    expect(options.triggers.map((t: any) => t.key)).toContain('lead.created');
    expect(options.stepTypes.map((t: any) => t.key)).toContain('wait');

    expect((await o.post('/automations', { name: 'Bad', trigger: 'lead.created', steps: [] })).status).toBe(400);
    expect((await o.post('/automations', { name: 'Bad', trigger: 'lead.created', steps: [{ type: 'move_stage', stageId: 'nope' }] })).status).toBe(400);
    expect((await o.post('/automations', { name: 'Bad', trigger: 'lead.exploded', steps: [{ type: 'archive' }] })).status).toBe(400);
    const a = await o.post('/automations', {
      name: 'Facebook welcome',
      trigger: 'lead.created',
      conditions: [{ field: 'source', op: 'is', value: fb }, { field: 'dealValue', op: 'is_empty' }],
      steps: [
        { type: 'add_label', labelId: hot },
        { type: 'assign', ownerId: agent.userId },
        { type: 'create_task', title: 'Welcome call for {{lead.name}}', dueInHours: 2, assignee: 'owner' },
        { type: 'wait', seconds: 2 },
        { type: 'move_stage', stageId: contacted },
        { type: 'add_to_list', listId: list.id },
        { type: 'notify', userId: 'owner', title: '{{lead.name}} is now in {{lead.stage}}' },
        { type: 'update_field', field: 'score', value: '70' },
      ],
    });
    expect(a.status).toBe(201);
    expect((await agent.get('/automations')).status).toBe(403);

    // A matching lead goes through every step, including the wait.
    const lead = (await o.post('/leads', { name: 'Auto Lead', phone: '9567800001', sourceId: fb, ownerId: null })).body;
    const done = await until(async () => (await o.get(`/automations/${a.body.id}/runs`)).body.items.find((r: any) => r.leadId === lead.id && r.status === 'DONE'), 20_000);
    expect(done.log.map((l: any) => l.type)).toEqual(['add_label', 'assign', 'create_task', 'wait', 'move_stage', 'add_to_list', 'notify', 'update_field']);
    const after = (await o.get(`/leads/${lead.id}`)).body;
    expect(after).toMatchObject({ stage: { name: 'Contacted' }, owner: { id: agent.userId }, score: 70, lists: [{ id: list.id, name: 'FB follow-ups' }] });
    expect(after.labels.map((l: any) => l.name)).toEqual(['Hot']);
    expect((await agent.get('/tasks?view=all')).body.items.map((t: any) => t.title)).toContain('Welcome call for Auto Lead');
    expect((await agent.get('/notifications')).body.items.map((n: any) => n.title)).toContain('Auto Lead is now in Contacted');
    expect((await o.get(`/leads/${lead.id}/activities`)).body.map((x: any) => x.type)).toContain('automation_ran');
    expect((await o.get('/automations')).body[0]).toMatchObject({ runs: 1, last30Days: { done: 1 } });

    // A lead from another source is skipped with the reason; a repeat within ten minutes is guarded.
    const other = (await o.post('/leads', { name: 'Other Source', phone: '9567800002', sourceId: sources[0].id === fb ? sources[1].id : sources[0].id })).body;
    const skipped = await until(async () => (await o.get(`/automations/${a.body.id}/runs`)).body.items.find((r: any) => r.leadId === other.id));
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.log[0].result).toContain('Condition not met: source');
    const manualSkip = await o.post(`/automations/${a.body.id}/test`, { leadId: other.id });
    expect(manualSkip.status).toBe(201);
    expect(manualSkip.body.status).toBe('SKIPPED');
    // A manual run on a matching lead executes synchronously up to the wait step, then parks.
    const manualRun = await o.post(`/automations/${a.body.id}/test`, { leadId: lead.id });
    expect(manualRun.body.status).toBe('WAITING');
    expect(manualRun.body.log.map((l: any) => l.type)).toEqual(['add_label', 'assign', 'create_task', 'wait']);
    // Manual test on a fresh matching lead runs synchronously up to the wait, then resumes.
    await o.patch(`/automations/${a.body.id}`, { steps: [{ type: 'add_label', labelId: hot }, { type: 'archive' }] });
    const fresh = (await o.post('/leads', { name: 'Fresh Lead', phone: '9567800003', sourceId: fb, ownerId: null })).body;
    await until(async () => (await o.get(`/automations/${a.body.id}/runs`)).body.items.find((r: any) => r.leadId === fresh.id && r.status === 'DONE'));
    expect((await o.get(`/leads/${fresh.id}`)).body.archivedAt).toBeTruthy();
    // Paused automations do nothing; deleting removes the history; other workspaces see nothing.
    await o.patch(`/automations/${a.body.id}`, { active: false });
    const quiet = (await o.post('/leads', { name: 'Quiet Lead', phone: '9567800004', sourceId: fb })).body;
    await new Promise((r) => setTimeout(r, 2500));
    expect((await o.get(`/automations/${a.body.id}/runs`)).body.items.find((r: any) => r.leadId === quiet.id)).toBeUndefined();
    const stranger = await registerOrg('AutoOther');
    expect((await stranger.get('/automations')).body).toHaveLength(0);
    expect((await stranger.get(`/automations/${a.body.id}/runs`)).status).toBe(404);
    expect((await stranger.post(`/automations/${a.body.id}/test`, { leadId: lead.id })).status).toBe(404);
    expect((await o.del(`/automations/${a.body.id}`)).status).toBe(200);
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

describe('deals and payments', () => {
  it('tracks deals per lead, forecasts open value and records payments within the lead scope', async () => {
    const o = await registerOrg('Deals');
    const agent = await addMember(o, 'Sales Agent');
    const lead = (await o.post('/leads', { name: 'Deal Lead', phone: '9666600001' })).body;
    const agentLead = (await agent.post('/leads', { name: 'Agent Deal Lead', phone: '9666600002' })).body;
    const nextMonth = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1, 10);
    const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1, 10);

    // Deals
    expect((await o.post('/opportunities', { leadId: lead.id, name: '' })).status).toBe(400);
    const d1 = await o.post('/opportunities', { leadId: lead.id, name: 'Annual plan', value: 100000, probability: 60, expectedCloseAt: nextMonth.toISOString() });
    expect(d1.status).toBe(201);
    expect(d1.body).toMatchObject({ status: 'OPEN', value: 100000, probability: 60, owner: { name: 'Owner One' } });
    const d2 = (await o.post('/opportunities', { leadId: lead.id, name: 'Training', value: 20000, probability: 50, expectedCloseAt: lastMonth.toISOString() })).body;
    const d3 = (await o.post('/opportunities', { leadId: lead.id, name: 'Unscheduled', value: 5000, probability: 20 })).body;
    const d4 = (await agent.post('/opportunities', { leadId: agentLead.id, name: 'Agent deal', value: 40000, probability: 100, expectedCloseAt: nextMonth.toISOString() })).body;
    expect((await agent.post('/opportunities', { leadId: lead.id, name: 'Not mine', value: 1 })).status).toBe(400);

    const fc = (await o.get('/opportunities/forecast?months=3')).body;
    expect(fc.total).toEqual({ count: 4, value: 165000, weighted: 60000 + 10000 + 1000 + 40000 });
    expect(fc.overdue).toEqual({ count: 1, value: 20000, weighted: 10000 });
    expect(fc.unscheduled).toEqual({ count: 1, value: 5000, weighted: 1000 });
    expect(fc.months[1]).toMatchObject({ count: 2, value: 140000, weighted: 100000 });
    expect((await agent.get('/opportunities/forecast')).body.total).toEqual({ count: 1, value: 40000, weighted: 40000 });

    const won = await o.patch(`/opportunities/${d1.body.id}`, { status: 'WON' });
    expect(won.body).toMatchObject({ status: 'WON', probability: 100 });
    expect(won.body.closedAt).toBeTruthy();
    const lost = await o.patch(`/opportunities/${d2.id}`, { status: 'LOST', lostReason: 'Budget cut' });
    expect(lost.body).toMatchObject({ status: 'LOST', lostReason: 'Budget cut' });
    const list = (await o.get('/opportunities?sort=value&dir=desc')).body;
    expect(list.total).toBe(4);
    expect(list.totals).toEqual({ open: { count: 2, value: 45000 }, won: { count: 1, value: 100000 }, lost: { count: 1, value: 20000 } });
    expect((await o.get('/opportunities?status=OPEN')).body.items.map((x: any) => x.name).sort()).toEqual(['Agent deal', 'Unscheduled']);
    expect((await agent.get('/opportunities')).body.items.map((x: any) => x.name)).toEqual(['Agent deal']);
    expect((await agent.get(`/opportunities/${d1.body.id}`)).status).toBe(404);
    expect((await agent.patch(`/opportunities/${d1.body.id}`, { value: 1 })).status).toBe(404);
    const types = (await o.get(`/leads/${lead.id}/activities`)).body.map((a: any) => a.type);
    expect(types).toEqual(expect.arrayContaining(['opportunity_created', 'opportunity_won', 'opportunity_lost']));
    expect((await o.get(`/leads/${lead.id}`)).body.opportunities).toHaveLength(3);

    // Payments
    expect((await o.post('/payments', { leadId: lead.id, amount: 0 })).status).toBe(400);
    expect((await o.post('/payments', { leadId: lead.id, amount: 100, opportunityId: d4.id })).status).toBe(400); // deal belongs to another lead
    const yesterday = new Date(Date.now() - 864e5).toISOString();
    const p1 = await o.post('/payments', { leadId: lead.id, opportunityId: d1.body.id, amount: 60000, method: 'UPI', status: 'PAID', reference: 'UPI123' });
    expect(p1.status).toBe(201);
    expect(p1.body).toMatchObject({ status: 'PAID', amount: 60000, currency: 'INR', opportunity: { name: 'Annual plan' } });
    expect(p1.body.paidAt).toBeTruthy();
    const p2 = (await o.post('/payments', { leadId: lead.id, opportunityId: d1.body.id, amount: 40000, method: 'BANK_TRANSFER', dueAt: yesterday })).body;
    const p3 = (await o.post('/payments', { leadId: lead.id, amount: 1500, dueAt: new Date(Date.now() + 7 * 864e5).toISOString() })).body;
    const p4 = (await agent.post('/payments', { leadId: agentLead.id, amount: 9000, status: 'PAID', method: 'CASH' })).body;

    const all = (await o.get('/payments')).body;
    expect(all.total).toBe(4);
    expect(all.totals).toMatchObject({ paid: { count: 2, amount: 69000 }, pending: { count: 2, amount: 41500 }, overdue: { count: 1, amount: 40000 } });
    expect((await o.get('/payments?status=OVERDUE')).body.items.map((p: any) => p.id)).toEqual([p2.id]);
    expect((await o.get('/payments?method=CASH')).body.items.map((p: any) => p.id)).toEqual([p4.id]);
    expect((await o.get('/payments?q=upi123')).body.total).toBe(1);
    expect((await agent.get('/payments')).body.items.map((p: any) => p.id)).toEqual([p4.id]);
    expect((await agent.patch(`/payments/${p2.id}`, { status: 'PAID' })).status).toBe(404);

    const paid = await o.patch(`/payments/${p2.id}`, { status: 'PAID', reference: 'NEFT987' });
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.paidAt).toBeTruthy();
    expect((await o.get(`/opportunities/${d1.body.id}`)).body.payments).toHaveLength(2);
    expect((await o.del(`/payments/${p2.id}`)).status).toBe(400); // paid: refund instead
    expect((await o.patch(`/payments/${p3.id}`, { status: 'REFUNDED' })).status).toBe(400); // never paid
    expect((await o.patch(`/payments/${p2.id}`, { status: 'REFUNDED' })).body.refundedAt).toBeTruthy();
    expect((await o.patch(`/payments/${p2.id}`, { status: 'PENDING' })).status).toBe(400);
    expect((await o.del(`/payments/${p3.id}`)).status).toBe(200);
    expect((await o.del(`/opportunities/${d1.body.id}`)).status).toBe(400); // has a paid payment
    expect((await o.del(`/opportunities/${d3.id}`)).status).toBe(200);
    const acts = (await o.get(`/leads/${lead.id}/activities`)).body.map((a: any) => a.type);
    expect(acts).toEqual(expect.arrayContaining(['payment_received', 'payment_recorded', 'payment_refunded', 'opportunity_deleted']));
    expect((await o.get(`/leads/${lead.id}`)).body.payments).toHaveLength(2);

    // Permissions and isolation.
    const role = (await o.post('/roles', { name: 'No money', scope: 'ALL', permissions: ['leads.view'] })).body;
    const users = (await o.get('/users')).body as any[];
    await o.patch(`/users/${users.find((u) => u.id === agent.userId).membershipId}`, { roleId: role.id });
    expect((await agent.get('/payments')).status).toBe(403);
    expect((await agent.post('/payments', { leadId: lead.id, amount: 5 })).status).toBe(403);
    expect((await agent.get(`/leads/${lead.id}`)).body.payments).toEqual([]);
    const other = await registerOrg('DealsOther');
    expect((await other.get('/opportunities')).body.total).toBe(0);
    expect((await other.get('/payments')).body.total).toBe(0);
    expect((await other.post('/opportunities', { leadId: lead.id, name: 'X', value: 1 })).status).toBe(400);
    expect((await other.post('/payments', { leadId: lead.id, amount: 1 })).status).toBe(400);
    expect((await other.patch(`/payments/${p1.body.id}`, { status: 'REFUNDED' })).status).toBe(404);
    expect((await other.del(`/opportunities/${d4.id}`)).status).toBe(404);
  });
});

/** Polls until the condition returns a value, for jobs that run on the queue. */
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('Timed out waiting for background work');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A throwaway HTTP server that records what webhooks it receives and answers with the configured status. */
function receiver() {
  const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { hits.push({ headers: req.headers, body }); res.statusCode = status; res.end('ok'); });
  });
  return {
    hits,
    setStatus: (s: number) => { status = s; },
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}/hook`))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('webhooks and outbox', () => {
  const rx = receiver();
  let url: string;
  beforeAll(async () => { url = await rx.start(); });
  afterAll(() => rx.stop());

  it('delivers signed events for subscribed types, retries failures and logs every attempt', async () => {
    const o = await registerOrg('Hooks');
    expect((await o.get('/webhook-events')).body).toContain('lead.created');
    expect((await o.post('/webhook-endpoints', { name: 'Bad', url: 'ftp://x', events: ['lead.created'] })).status).toBe(400);
    expect((await o.post('/webhook-endpoints', { name: 'Bad', url, events: ['lead.exploded'] })).status).toBe(400);
    const ep = await o.post('/webhook-endpoints', { name: 'Zapier', url, events: ['lead.created', 'lead.stage_changed'] });
    expect(ep.status).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_/);
    const secret = ep.body.secret as string;
    expect((await o.get('/webhook-endpoints')).body[0].secret).toBeUndefined();

    const lead = (await o.post('/leads', { name: 'Hooked Lead', phone: '9777700001' })).body;
    const first = await until(async () => rx.hits[0]);
    const payload = JSON.parse(first.body);
    expect(payload.type).toBe('lead.created');
    expect(payload.data.lead.id).toBe(lead.id);
    expect(first.headers['x-powermycrm-event']).toBe('lead.created');
    const [t, v1] = (first.headers['x-powermycrm-signature'] as string).split(',').map((p) => p.split('=')[1]);
    expect(createHmac('sha256', secret).update(`${t}.${first.body}`).digest('hex')).toBe(v1);

    // Assignment is not subscribed; a stage change is.
    const agent = await addMember(o, 'Sales Agent');
    await o.patch(`/leads/${lead.id}`, { ownerId: agent.userId });
    const stages = (await o.get('/pipelines')).body[0].stages;
    await o.patch(`/leads/${lead.id}`, { stageId: stages[1].id });
    const second = await until(async () => rx.hits[1]);
    expect(JSON.parse(second.body).type).toBe('lead.stage_changed');
    expect(JSON.parse(second.body).data.to.name).toBe('Contacted');
    await new Promise((r) => setTimeout(r, 1500));
    expect(rx.hits).toHaveLength(2);
    const log = (await o.get(`/webhook-endpoints/${ep.body.id}/deliveries`)).body;
    expect(log.total).toBe(2);
    expect(log.items.every((d: any) => d.status === 'DELIVERED' && d.responseCode === 200 && d.attempts === 1)).toBe(true);
    expect((await o.get('/webhook-endpoints')).body[0]).toMatchObject({ lastStatus: 200, deliveries: { delivered: 2, pending: 0, failed: 0 } });

    // A failing receiver: the attempt is logged with its status and the delivery stays pending for retry.
    rx.setStatus(500);
    const test = await o.post(`/webhook-endpoints/${ep.body.id}/test`);
    expect(test.status).toBe(200);
    const failed = await until(async () => {
      const d = (await o.get(`/webhook-endpoints/${ep.body.id}/deliveries`)).body.items.find((x: any) => x.id === test.body.deliveryId);
      return d?.attempts >= 1 ? d : null;
    });
    expect(failed).toMatchObject({ eventType: 'webhook.test', status: 'PENDING', responseCode: 500, error: 'HTTP 500' });
    rx.setStatus(200);
    expect((await o.post(`/webhook-deliveries/${failed.id}/retry`)).status).toBe(200);
    const redone = await until(async () => {
      const d = (await o.get(`/webhook-endpoints/${ep.body.id}/deliveries`)).body.items.find((x: any) => x.id === failed.id);
      return d?.status === 'DELIVERED' ? d : null;
    });
    expect(redone.attempts).toBe(2);

    // Paused endpoints receive nothing; other workspaces cannot touch the endpoint.
    await o.patch(`/webhook-endpoints/${ep.body.id}`, { active: false });
    const before = rx.hits.length;
    await o.post('/leads', { name: 'Silent', phone: '9777700002' });
    await new Promise((r) => setTimeout(r, 2000));
    expect(rx.hits.length).toBe(before);
    expect((await agent.get('/webhook-endpoints')).status).toBe(403);
    const other = await registerOrg('HooksOther');
    expect((await other.get('/webhook-endpoints')).body).toHaveLength(0);
    expect((await other.get(`/webhook-endpoints/${ep.body.id}/deliveries`)).status).toBe(404);
    expect((await other.del(`/webhook-endpoints/${ep.body.id}`)).status).toBe(404);
    expect((await o.del(`/webhook-endpoints/${ep.body.id}`)).status).toBe(200);
  });
});

describe('integrations: website forms and the public API', () => {
  it('turns form submissions into leads through the queue, with mapping, de-duplication and auto-assignment', async () => {
    const o = await registerOrg('Forms');
    const a = await addMember(o, 'Sales Agent');
    const b = await addMember(o, 'Sales Agent');
    await o.post('/assignment-rules', { name: 'Web', userIds: [a.userId, b.userId] });
    const sources = (await o.get('/sources')).body;
    const web = sources.find((s: any) => s.name === 'Website').id;
    await o.post('/custom-fields', { label: 'Budget', type: 'NUMBER' });

    expect((await o.get('/integrations/providers')).body.providers.map((p: any) => p.key)).toEqual(['website_form', 'smtp']);
    const created = await o.post('/integrations', { provider: 'website_form', name: 'Landing page', settings: { sourceId: web, ownerId: 'auto', duplicateStrategy: 'skip' }, fieldMapping: { name: 'full_name', cf_budget: 'budget' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'CONNECTED' });
    expect(created.body.token).toMatch(/^pmf_/);
    expect(created.body.endpointUrl).toContain(`/api/v1/hooks/website_form/${created.body.id}`);
    const { id, token } = created.body;
    const hook = `/api/v1/hooks/website_form/${id}`;

    expect((await request(server).post(hook).send({ full_name: 'X' })).status).toBe(401);
    expect((await request(server).post(hook + '?token=wrong').send({ full_name: 'X' })).status).toBe(401);
    const sub = await request(server).post(hook).set('X-Form-Token', token).send({ full_name: 'Form Lead', phone: '9888800001', budget: '45', message: 'Please call after 6pm', _hp: '' });
    expect(sub.status).toBe(202);
    const lead = await until(async () => (await o.get('/leads?q=Form Lead')).body.items[0]);
    expect(lead).toMatchObject({ phone: '9888800001', source: { name: 'Website' }, customFields: { budget: 45 } });
    expect([a.userId, b.userId]).toContain(lead.owner.id);
    const acts = (await o.get(`/leads/${lead.id}/activities`)).body;
    expect(acts.find((x: any) => x.type === 'created').data).toMatchObject({ via: 'website_form', integrationId: id });
    expect(acts.find((x: any) => x.type === 'note').data.body).toBe('Please call after 6pm');
    const ev = await until(async () => (await o.get(`/integrations/${id}/events`)).body.items.find((e: any) => e.status === 'PROCESSED'));
    expect(ev.lead.id).toBe(lead.id);

    // Second submission with the same phone is a repeat enquiry: no new lead, a note on the existing one.
    const again = await request(server).post(hook).set('X-Form-Token', token).send({ full_name: 'Form Lead Again', phone: '09888800001', message: 'Second enquiry' });
    expect(again.status).toBe(202);
    await until(async () => (await o.get(`/integrations/${id}/events`)).body.items.find((e: any) => e.status === 'SKIPPED'));
    expect((await o.get('/leads?q=Form Lead')).body.total).toBe(1);
    expect((await o.get(`/leads/${lead.id}/activities`)).body.filter((x: any) => x.type === 'note')).toHaveLength(2);
    // Honeypot and duplicate external ids are acknowledged but create nothing.
    expect((await request(server).post(hook + '?token=' + token).send({ full_name: 'Bot', phone: '9888800009', _hp: 'spam' })).status).toBe(202);
    expect((await request(server).post(hook + '?token=' + token).send({ full_name: 'Ext', phone: '9888800003', _id: 'req-1' })).status).toBe(202);
    const dup = await request(server).post(hook + '?token=' + token).send({ full_name: 'Ext', phone: '9888800003', _id: 'req-1' });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    await until(async () => (await o.get('/leads?q=Ext')).body.items[0]);
    const events = (await o.get(`/integrations/${id}/events`)).body;
    expect(events.items.map((e: any) => e.status).sort()).toEqual(['PROCESSED', 'PROCESSED', 'SKIPPED', 'SKIPPED']);
    expect((await o.get('/integrations')).body[0].events).toMatchObject({ processed: 2, skipped: 2, failed: 0 });

    // Form-encoded posts from a plain HTML form redirect when a redirect URL is set; a submission with nothing usable fails visibly.
    await o.patch(`/integrations/${id}`, { settings: { sourceId: web, ownerId: 'auto', duplicateStrategy: 'skip', redirectUrl: 'https://example.com/thanks' } });
    const html = await request(server).post(hook).type('form').send({ _token: token, full_name: 'Browser Lead', phone: '9888800004' });
    expect(html.status).toBe(303);
    expect(html.headers.location).toBe('https://example.com/thanks');
    await until(async () => (await o.get('/leads?q=Browser Lead')).body.items[0]);
    await request(server).post(hook + '?token=' + token).send({ comment: 'no contact details at all' });
    const failed = await until(async () => (await o.get(`/integrations/${id}/events`)).body.items.find((e: any) => e.status === 'FAILED'));
    expect(failed.error).toContain('name, phone or email');
    expect((await o.post(`/integrations/${id}/events/${failed.id}/retry`)).status).toBe(200);

    // Disabled integrations reject submissions; tokens rotate; other workspaces see nothing.
    await o.patch(`/integrations/${id}`, { status: 'DISABLED' });
    expect((await request(server).post(hook + '?token=' + token).send({ full_name: 'Late' })).status).toBe(404);
    await o.patch(`/integrations/${id}`, { status: 'CONNECTED' });
    const rotated = (await o.post(`/integrations/${id}/rotate-token`)).body.token;
    expect((await request(server).post(hook + '?token=' + token).send({ full_name: 'Old token' })).status).toBe(401);
    expect((await request(server).post(hook + '?token=' + rotated).send({ full_name: 'New token', phone: '9888800005' })).status).toBe(202);
    expect((await a.get('/integrations')).status).toBe(403);
    const other = await registerOrg('FormsOther');
    expect((await other.get('/integrations')).body).toHaveLength(0);
    expect((await other.get(`/integrations/${id}/events`)).status).toBe(404);
    expect((await other.post('/integrations', { provider: 'website_form', name: 'X', settings: { sourceId: web } })).status).toBe(400);
  });

  it('captures leads through the public API with a bearer key', async () => {
    const o = await registerOrg('ApiKeys');
    const k = await o.post('/api-keys', { name: 'Zapier' });
    expect(k.status).toBe(201);
    expect(k.body.key).toMatch(/^pmc_live_/);
    expect((await o.get('/api-keys')).body[0].key).toBeUndefined();
    const pub = (path: string) => request(server).post(`/api/v1${path}`);
    expect((await pub('/public/leads').send({ name: 'No key' })).status).toBe(401);
    expect((await pub('/public/leads').set('Authorization', 'Bearer pmc_live_nope').send({ name: 'Bad key' })).status).toBe(401);
    expect((await request(server).get('/api/v1/public/me').set('Authorization', `Bearer ${k.body.key}`)).body.key).toBe('Zapier');

    const r = await pub('/public/leads').set('Authorization', `Bearer ${k.body.key}`).send({ name: 'API Lead', email: 'API@Example.com', source: 'Partner portal', message: 'From the partner', externalId: 'ext-9' });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('created');
    const lead = (await o.get(`/leads/${r.body.id}`)).body;
    expect(lead).toMatchObject({ email: 'api@example.com', source: { name: 'Partner portal' }, owner: null });
    expect((await o.get('/sources')).body.map((s: any) => s.name)).toContain('Partner portal');
    const again = await pub('/public/leads').set('Authorization', `Bearer ${k.body.key}`).send({ email: 'api@example.com', company: 'Acme', duplicateStrategy: 'update' });
    expect(again.body).toEqual({ id: r.body.id, outcome: 'updated' });
    expect((await o.get(`/leads/${r.body.id}`)).body.company).toBe('Acme');
    expect((await pub('/public/leads').set('Authorization', `Bearer ${k.body.key}`).send({ email: 'not-an-email' })).status).toBe(400);
    expect((await o.get('/api-keys')).body[0].lastUsedAt).toBeTruthy();

    expect((await o.del(`/api-keys/${k.body.id}`)).status).toBe(200);
    expect((await pub('/public/leads').set('Authorization', `Bearer ${k.body.key}`).send({ name: 'Revoked' })).status).toBe(401);
    const other = await registerOrg('ApiKeysOther');
    expect((await other.del(`/api-keys/${k.body.id}`)).status).toBe(404);
    expect((await other.get('/leads?q=API Lead')).body.total).toBe(0);
  });
});

/** A local SMTP server that keeps what it receives, so email delivery is tested for real. */
function mailbox() {
  const mails: { to: string[]; subject: string; text: string }[] = [];
  const qp = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '';
        // Text part sits between the first boundary and the next; decode quoted-printable soft breaks.
        const text = qp(raw.split(/\r?\n\r?\n/).slice(1).join('\n\n'));
        mails.push({ to: session.envelope.rcptTo.map((r) => r.address), subject, text });
        cb();
      });
    },
  });
  return {
    mails,
    start: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.server.address() as any).port))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    link: (text: string, path: string) => new RegExp(`https?://[^\\s]*${path}[^\\s]*`).exec(text)?.[0] ?? '',
  };
}

describe('email delivery', () => {
  const box = mailbox();
  let port: number;
  beforeAll(async () => { port = await box.start(); });
  afterAll(() => box.stop());

  it('connects SMTP only after a real test, then sends invitations, resets and verification emails', async () => {
    const o = await registerOrg('Mail');
    // Nothing is connected: the invitation link is handed back for the admin, and the email is recorded as skipped.
    const roles = (await o.get('/roles')).body as any[];
    const noMail = await o.post('/invitations', { email: 'first@example.com', roleId: roles.find((r) => r.name === 'Sales Agent').id });
    expect(noMail.body.emailSent).toBe(false);
    expect(noMail.body.inviteUrl).toContain('/invite/');
    const status0 = (await o.get('/integrations/email-status')).body;
    expect(status0).toMatchObject({ canSend: false, integration: null });

    // Wrong port: the integration exists but is not connected, and says why.
    const bad = await o.post('/integrations', { provider: 'smtp', name: 'Mail', credentials: { host: '127.0.0.1', port: 1, from: 'crm@test.local' } });
    expect(bad.status).toBe(201);
    expect(bad.body.status).toBe('ERROR');
    expect(bad.body.lastError).toBeTruthy();
    expect(bad.body.credentials).toMatchObject({ host: '127.0.0.1', port: 1, hasPassword: false });
    expect(bad.body.credentials.pass).toBeUndefined();
    expect((await o.post('/integrations', { provider: 'smtp', name: 'Second', credentials: { host: 'x', from: 'y@z.com' } })).status).toBe(409);
    expect((await o.post(`/integrations/${bad.body.id}/send-test`)).status).toBe(400);
    // Fix the port: a re-test connects.
    const fixed = await o.patch(`/integrations/${bad.body.id}`, { credentials: { port } });
    expect(fixed.body.status).toBe('CONNECTED');
    expect((await o.get('/integrations/email-status')).body).toMatchObject({ canSend: true, via: `smtp:${bad.body.id}` });

    // Test email, invitation, password reset and verification all arrive through the connection.
    const t = await o.post(`/integrations/${bad.body.id}/send-test`);
    expect(t.status).toBe(200);
    await until(async () => box.mails.find((m) => m.subject.includes('test email')));
    const inv = await o.post('/invitations', { email: 'second@example.com', roleId: roles.find((r) => r.name === 'Manager').id });
    expect(inv.body.emailSent).toBe(true);
    const invMail = await until(async () => box.mails.find((m) => m.to.includes('second@example.com')));
    expect(invMail.subject).toContain('invited you');
    const inviteToken = box.link(invMail.text, '/invite/').split('/invite/')[1];
    expect(inviteToken).toBe(inv.body.inviteUrl.split('/invite/')[1]);
    const accepted = await request(server).post(`/api/v1/auth/invitations/${inviteToken}/accept`).send({ name: 'Second Person', password: PW });
    expect(accepted.status).toBe(201);

    await request(server).post('/api/v1/auth/forgot-password').send({ email: o.email });
    const resetMail = await until(async () => box.mails.find((m) => m.to.includes(o.email) && m.subject.includes('Reset')));
    const resetToken = new URL(box.link(resetMail.text, '/reset-password')).searchParams.get('token');
    expect((await request(server).post('/api/v1/auth/reset-password').send({ token: resetToken, password: 'another-pass-99' })).status).toBe(200);

    expect((await o.get('/auth/me')).status).toBe(401); // reset signed the owner out
    const login = await request(server).post('/api/v1/auth/login').send({ email: o.email, password: 'another-pass-99' });
    const me = client(request.agent(server), login.body.accessToken);
    expect((await me.get('/auth/me')).body.user.emailVerified).toBe(false);
    const resend = await me.post('/auth/resend-verification');
    expect(resend.body.emailSent).toBe(true);
    const verifyMail = await until(async () => box.mails.find((m) => m.to.includes(o.email) && m.subject.includes('Verify')));
    const verifyToken = new URL(box.link(verifyMail.text, '/verify-email')).searchParams.get('token');
    expect((await request(server).post('/api/v1/auth/verify-email').send({ token: verifyToken })).status).toBe(200);
    expect((await request(server).post('/api/v1/auth/verify-email').send({ token: verifyToken })).status).toBe(400);
    expect((await me.get('/auth/me')).body.user.emailVerified).toBe(true);
    expect((await me.post('/auth/resend-verification')).body.verified).toBe(true);

    // The log shows every message with its outcome; other workspaces see nothing.
    const log = (await me.get('/emails')).body;
    expect(log.items.map((m: any) => [m.kind, m.status])).toEqual(expect.arrayContaining([['invitation', 'SKIPPED'], ['invitation', 'SENT'], ['test', 'SENT'], ['verify_email', 'SENT']]));
    expect(log.items.find((m: any) => m.kind === 'invitation' && m.status === 'SKIPPED').error).toContain('No email provider');
    const other = await registerOrg('MailOther');
    // Registering queued the new owner's verification email (skipped, nothing connected) and nothing else.
    expect((await other.get('/emails')).body.items.map((m: any) => [m.kind, m.status])).toEqual([['verify_email', 'SKIPPED']]);
    expect((await other.post(`/integrations/${bad.body.id}/test`)).status).toBe(404);
  });
});

describe('super admin and plans', () => {
  it('limits workspaces to their plan and lets platform admins manage organisations and plans', async () => {
    const o = await registerOrg('Planned');
    const prisma = app.get(PrismaService);
    const plan = (await o.get('/organisation/plan')).body;
    expect(plan.plan.key).toBe('free');
    expect(plan.usage).toMatchObject({ users: 1, leads: 0 });
    expect(plan.selfServiceBilling).toBe(false);
    expect((await o.get('/admin/overview')).status).toBe(403);

    // A super-admin is a flagged user; they use the normal API plus /admin.
    const admin = await registerOrg('Platform');
    const me = (await admin.get('/auth/me')).body.user;
    expect(me.isSuperAdmin).toBe(false);
    await prisma.user.update({ where: { id: me.id }, data: { isSuperAdmin: true } });
    expect((await admin.get('/auth/me')).body.user.isSuperAdmin).toBe(true);
    const overview = (await admin.get('/admin/overview')).body;
    expect(overview.organisations).toBeGreaterThan(1);
    const plans = (await admin.get('/admin/plans')).body;
    expect(plans.map((p: any) => p.key)).toEqual(['free', 'growth', 'enterprise']);
    const tiny = await admin.post('/admin/plans', { key: 'tiny', name: 'Tiny', limits: { users: 1, leads: 2, automations: 0, storageMb: 1, webhooks: 0 } });
    expect(tiny.status).toBe(201);
    expect((await admin.post('/admin/plans', { key: 'tiny', name: 'Dup', limits: tiny.body.limits })).status).toBe(400);

    const listed = (await admin.get('/admin/organisations?q=Planned')).body;
    expect(listed.total).toBe(1);
    const orgId = listed.items[0].id;
    expect(listed.items[0]).toMatchObject({ plan: 'Free', members: 1, owner: { email: o.email } });
    await admin.patch(`/admin/organisations/${orgId}`, { planId: tiny.body.id });
    expect((await o.get('/organisation/plan')).body.plan.key).toBe('tiny');

    // Limits bite: two leads fit, the third does not (create, import and the public API alike); users and automations too.
    expect((await o.post('/leads', { name: 'One' })).status).toBe(201);
    expect((await o.post('/leads', { name: 'Two' })).status).toBe(201);
    const third = await o.post('/leads', { name: 'Three' });
    expect(third.status).toBe(403);
    expect(third.body.code).toBe('PLAN_LIMIT');
    expect((await o.post('/leads/import', { rows: [{ name: 'Four', phone: '9000000004' }] })).status).toBe(403);
    const roles = (await o.get('/roles')).body as any[];
    expect((await o.post('/invitations', { email: 'more@example.com', roleId: roles[1].id })).body.code).toBe('PLAN_LIMIT');
    expect((await o.post('/automations', { name: 'X', trigger: 'lead.created', steps: [{ type: 'archive' }] })).body.code).toBe('PLAN_LIMIT');
    expect((await o.post('/webhook-endpoints', { name: 'X', url: 'https://example.com/h', events: ['*'] })).body.code).toBe('PLAN_LIMIT');
    // Back on a roomier plan everything works again; suspension locks everyone out at once.
    const growth = plans.find((p: any) => p.key === 'growth').id;
    await admin.patch(`/admin/organisations/${orgId}`, { planId: growth });
    expect((await o.post('/leads', { name: 'Three' })).status).toBe(201);
    await admin.patch(`/admin/organisations/${orgId}`, { status: 'SUSPENDED' });
    expect((await o.get('/leads')).status).toBe(401);
    expect((await admin.get(`/admin/organisations/${orgId}`)).body.status).toBe('SUSPENDED');
    await admin.patch(`/admin/organisations/${orgId}`, { status: 'ACTIVE' });
    expect((await o.get('/leads')).status).toBe(200);
    expect((await admin.get('/admin/organisations/nope')).status).toBe(404);
    // Plans can be retired; the default plan is what new workspaces receive.
    await admin.patch(`/admin/plans/${tiny.body.id}`, { active: false });
    expect((await o.get('/organisation/plan')).body.available.map((p: any) => p.key)).not.toContain('tiny');
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
