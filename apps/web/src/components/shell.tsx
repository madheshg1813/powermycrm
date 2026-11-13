'use client';
import {
  Banknote, BarChart3, Bell, Building2, CalendarCheck, ChevronsLeft, Handshake, MessageCircle, ShieldCheck, ChevronsRight, ChevronDown, Columns3, LayoutDashboard, Menu, Plus, Search, Settings, UserPlus, Users, UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setAccessToken, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relTime } from '@/lib/format';
import { Lead, useChanged, useRefs } from '@/lib/refs';
import { LeadForm, TaskForm } from './forms';
import { ColorDot, Dropdown, Logo, Spinner, cx } from './ui';

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; show?: boolean; badge?: number };

export function Shell({ children }: { children: React.ReactNode }) {
  const { me, can, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [leadForm, setLeadForm] = useState(false);
  const [taskForm, setTaskForm] = useState(false);
  const overdue = useApi<{ counts: { overdue: number } }>('/tasks?view=overdue&pageSize=1');
  const { connected } = useRefs();
  const messaging = connected.whatsapp || connected.sms_http;
  const inbox = useApi<{ unreadTotal: number }>(messaging && can('leads.view') ? '/conversations?pageSize=1' : null);
  useChanged(() => { overdue.reload(); inbox.reload(); });
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') inbox.reload(); }, 30_000); return () => clearInterval(t); }, [inbox]);

  useEffect(() => {
    setCollapsed(localStorage.getItem('pmc:nav') === 'collapsed');
  }, []);
  useEffect(() => setMobileNav(false), [pathname]);
  const toggle = () => setCollapsed((c) => { localStorage.setItem('pmc:nav', c ? 'open' : 'collapsed'); return !c; });

  if (!me) return null;
  const main: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/leads', label: 'Leads', icon: Users, show: can('leads.view') },
    { href: '/pipeline', label: 'Pipeline', icon: Columns3, show: can('leads.view') },
    { href: '/follow-ups', label: 'Follow-ups', icon: CalendarCheck, badge: overdue.data?.counts.overdue },
    { href: '/inbox', label: 'Inbox', icon: MessageCircle, show: !!messaging && can('leads.view'), badge: inbox.data?.unreadTotal },
    { href: '/opportunities', label: 'Deals', icon: Handshake, show: can('leads.view') },
    { href: '/payments', label: 'Payments', icon: Banknote, show: can('payments.view') },
    { href: '/reports', label: 'Reports', icon: BarChart3, show: can('reports.view') },
  ];
  const setup: NavItem[] = [
    { href: '/team', label: 'Team', icon: UsersRound, show: can('users.view') || can('users.manage') || can('roles.manage') },
    { href: '/settings', label: 'Settings', icon: Settings },
    { href: '/admin', label: 'Platform admin', icon: ShieldCheck, show: me.user.isSuperAdmin },
  ];

  const nav = (items: NavItem[], compact: boolean) =>
    items.filter((i) => i.show !== false).map((i) => {
      const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
      return (
        <Link key={i.href} href={i.href} title={compact ? i.label : undefined} aria-current={active ? 'page' : undefined}
          className={cx('flex items-center gap-3 rounded-full px-3.5 py-2 text-[14px] font-medium transition', active ? 'bg-ink text-white' : 'text-ink-soft hover:bg-ink/5', compact && 'justify-center px-0')}>
          <i.icon className="h-[18px] w-[18px] shrink-0" />
          {!compact && <span className="flex-1 truncate">{i.label}</span>}
          {!compact && !!i.badge && <span className={cx('pill', active ? 'bg-white text-ink' : 'bg-ink text-white')}>{i.badge}</span>}
        </Link>
      );
    });

  const sidebar = (compact: boolean) => (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className={cx('flex h-12 items-center', compact ? 'justify-center' : 'justify-between px-2')}>
        <Link href="/dashboard" aria-label="Power My CRM home"><Logo compact={compact} /></Link>
        {!compact && <button className="btn-icon hidden lg:inline-flex" onClick={toggle} aria-label="Collapse navigation"><ChevronsLeft className="h-4 w-4" /></button>}
      </div>
      {compact && <button className="btn-icon mx-auto" onClick={toggle} aria-label="Expand navigation"><ChevronsRight className="h-4 w-4" /></button>}
      <nav className="mt-2 flex flex-col gap-1" aria-label="Main">{nav(main, compact)}</nav>
      {!compact && <p className="overline mt-5 px-3.5">Setup</p>}
      <nav className={cx('flex flex-col gap-1', compact ? 'mt-3 border-t border-ink/10 pt-3' : 'mt-1.5')} aria-label="Setup">{nav(setup, compact)}</nav>
      {!compact && (
        <div className="card mt-auto p-3.5">
          <p className="truncate font-semibold">{me.organisation.name}</p>
          <p className="mt-0.5 truncate text-[13px] text-ink-muted">{me.user.email}</p>
          <div className="mt-2.5 flex items-center gap-3 border-t border-ink/10 pt-2.5 text-[13px]">
            <button className="font-semibold hover:underline" onClick={signOut}>Sign out</button>
            <span className="text-ink-muted">{me.role.name}</span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={cx('sticky top-0 hidden h-screen shrink-0 border-r border-ink/10 lg:block', collapsed ? 'w-[68px]' : 'w-[248px]')}>{sidebar(collapsed)}</aside>
      {mobileNav && (
        <div className="fixed inset-0 z-50 bg-ink/40 lg:hidden" onClick={() => setMobileNav(false)}>
          <aside className="h-full w-[264px] bg-cream shadow-pop" onClick={(e) => e.stopPropagation()}>{sidebar(false)}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-ink/10 bg-cream/95 px-3 backdrop-blur sm:gap-3 sm:px-6">
          <button className="btn-icon lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></button>
          {can('leads.view') ? <GlobalSearch /> : <span className="flex-1" />}
          <div className="ml-auto flex items-center gap-2">
            <WorkspaceSwitcher />
            <Notifications />
            <Dropdown trigger={() => <button className="btn-primary"><Plus className="h-4 w-4" /><span className="hidden sm:inline">New</span></button>}>
              {(close) => (
                <>
                  {can('leads.create') && <button className="menu-item" onClick={() => { close(); setLeadForm(true); }}><UserPlus className="h-4 w-4 text-ink-muted" />New lead</button>}
                  <button className="menu-item" onClick={() => { close(); setTaskForm(true); }}><CalendarCheck className="h-4 w-4 text-ink-muted" />New follow-up</button>
                </>
              )}
            </Dropdown>
          </div>
        </header>
        {!me.user.emailVerified && <VerifyBanner />}
        <main className="flex-1 px-3 py-5 sm:px-6 sm:py-7">{children}</main>
      </div>

      <LeadForm open={leadForm} onClose={() => setLeadForm(false)} onSaved={(l) => router.push(`/leads/${l.id}`)} />
      <TaskForm open={taskForm} onClose={() => setTaskForm(false)} />
    </div>
  );
}

/** Shown until the user's email address is verified. Resending only works once an email connection exists. */
function VerifyBanner() {
  const { me } = useAuth();
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'nomail' | 'error'>('idle');
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(sessionStorage.getItem('pmc:verify-hidden') === '1'); } catch { /* ignore */ } }, []);
  if (hidden || !me) return null;
  const resend = async () => {
    setState('busy');
    try { const r = await api<{ emailSent: boolean }>('/auth/resend-verification', { body: {} }); setState(r.emailSent ? 'sent' : 'nomail'); }
    catch { setState('error'); }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber/20 bg-amber-soft px-3 py-2 text-[13px] text-amber sm:px-6" role="status">
      <span className="font-medium">Verify your email address ({me.user.email}) so password resets reach you.</span>
      {state === 'sent' ? <span>Verification email sent. Check your inbox.</span>
        : state === 'nomail' ? <span>No email connection is set up yet. An administrator can add one under Settings → Integrations.</span>
        : state === 'error' ? <span>Could not send right now. Try again in a minute.</span>
        : <button className="font-semibold underline" onClick={resend} disabled={state === 'busy'}>{state === 'busy' ? 'Sending…' : 'Resend verification email'}</button>}
      <button className="ml-auto text-amber/70 hover:text-amber" onClick={() => { setHidden(true); try { sessionStorage.setItem('pmc:verify-hidden', '1'); } catch { /* ignore */ } }} aria-label="Hide for this session">Hide</button>
    </div>
  );
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Lead[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); }
    };
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults(null); return; }
    setBusy(true);
    const t = setTimeout(async () => {
      try { setResults((await api<{ items: Lead[] }>(`/leads?pageSize=6&q=${encodeURIComponent(term)}`)).items); }
      catch { setResults([]); }
      finally { setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const go = (href: string) => { setOpen(false); setQ(''); input.current?.blur(); router.push(href); };

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-md" ref={box}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        ref={input} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) go(`/leads?q=${encodeURIComponent(q.trim())}`); if (e.key === 'Escape') setOpen(false); }}
        className="input rounded-full pl-10 pr-16" placeholder="Search leads by name, phone, email…" aria-label="Search leads"
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-ink/15 px-1.5 py-0.5 text-[11px] text-ink-muted sm:block">Ctrl K</kbd>
      {open && q.trim().length >= 2 && (
        <div className="menu left-0 right-0 top-full mt-2">
          {busy && !results ? <div className="flex justify-center p-4"><Spinner /></div>
            : !results?.length ? <p className="px-3 py-3 text-ink-muted">No leads match &ldquo;{q.trim()}&rdquo;.</p>
            : results.map((l) => (
              <button key={l.id} className="menu-item" onClick={() => go(`/leads/${l.id}`)}>
                <ColorDot color={l.stage.color} />
                <span className="min-w-0 flex-1 truncate"><span className="font-medium">{l.name}</span><span className="text-ink-muted"> {l.phone ?? l.email ?? ''}</span></span>
                <span className="text-xs text-ink-muted">{l.stage.name}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceSwitcher() {
  const { me } = useAuth();
  if (!me) return null;
  const others = me.organisations.filter((o) => o.id !== me.organisation.id);
  const label = <><Building2 className="h-4 w-4 text-ink-muted" /><span className="max-w-[140px] truncate">{me.organisation.name}</span></>;
  if (!others.length) return <span className="btn-ghost pointer-events-none hidden md:inline-flex">{label}</span>;
  const switchTo = async (organisationId: string) => {
    const r = await api<{ accessToken: string }>('/auth/switch', { body: { organisationId } });
    setAccessToken(r.accessToken);
    window.location.assign('/dashboard');
  };
  return (
    <Dropdown trigger={() => <button className="btn-ghost hidden md:inline-flex">{label}<ChevronDown className="h-4 w-4 text-ink-muted" /></button>}>
      {(close) => others.map((o) => <button key={o.id} className="menu-item" onClick={() => { close(); switchTo(o.id); }}>{o.name}</button>)}
    </Dropdown>
  );
}

function Notifications() {
  const router = useRouter();
  const { data, reload } = useApi<{ unread: number; items: { id: string; title: string; link: string | null; readAt: string | null; createdAt: string }[] }>('/notifications');
  const poll = useCallback(() => { if (document.visibilityState === 'visible') reload(); }, [reload]);
  useEffect(() => {
    const t = setInterval(poll, 60_000);
    return () => clearInterval(t);
  }, [poll]);
  useChanged(reload);

  const markAll = async () => { await api('/notifications/read', { body: {} }); reload(); };
  const open = async (n: { id: string; link: string | null; readAt: string | null }) => {
    if (!n.readAt) { await api('/notifications/read', { body: { id: n.id } }); reload(); }
    if (n.link) router.push(n.link);
  };

  return (
    <Dropdown className="w-[320px] max-w-[calc(100vw-24px)]" trigger={() => (
      <button className="btn-icon relative h-9 w-9" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}>
        <Bell className="h-[18px] w-[18px]" />
        {!!data?.unread && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
    )}>
      {(close) => (
        <>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="font-display font-bold">Notifications</span>
            {!!data?.unread && <button className="text-xs font-semibold text-ink-muted hover:text-ink" onClick={markAll}>Mark all read</button>}
          </div>
          {!data?.items.length ? <p className="px-3 pb-3 text-ink-muted">You&rsquo;re all caught up.</p> : (
            <div className="max-h-80 overflow-y-auto">
              {data.items.map((n) => (
                <button key={n.id} className="menu-item items-start" onClick={() => { close(); open(n); }}>
                  <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand')} />
                  <span className="min-w-0 flex-1"><span className={cx('block', !n.readAt && 'font-semibold')}>{n.title}</span><span className="text-xs text-ink-muted">{relTime(n.createdAt)}</span></span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Dropdown>
  );
}
