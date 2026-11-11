'use client';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, refreshSession, setAccessToken } from './api';

export type Me = {
  user: { id: string; name: string; email: string; phone: string | null; emailVerified: boolean };
  organisation: { id: string; name: string; slug: string; timezone: string; currency: string; dateFormat: string; logoUrl: string | null };
  role: { id: string; name: string; scope: 'OWN' | 'TEAM' | 'ALL'; systemKey: string | null };
  permissions: string[];
  teamId: string | null;
  organisations: { id: string; name: string }[];
};

type AuthState = {
  me: Me | null;
  loading: boolean;
  can: (permission: string) => boolean;
  /** Stores a fresh access token (after login/register/invite) and loads the profile. */
  signIn: (accessToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  reloadMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reloadMe = useCallback(async () => {
    setMe(await api<Me>('/auth/me'));
  }, []);

  useEffect(() => {
    (async () => {
      if (await refreshSession()) await reloadMe().catch(() => setMe(null));
      setLoading(false);
    })();
    const onSignedOut = () => {
      setAccessToken(null);
      setMe(null);
    };
    window.addEventListener('pmc:signed-out', onSignedOut);
    return () => window.removeEventListener('pmc:signed-out', onSignedOut);
  }, [reloadMe]);

  const signIn = useCallback(async (token: string) => {
    setAccessToken(token);
    await reloadMe();
  }, [reloadMe]);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setMe(null);
    router.replace('/login');
  }, [router]);

  const can = useCallback((p: string) => !!me?.permissions.includes(p), [me]);

  return <AuthContext.Provider value={{ me, loading, can, signIn, signOut, reloadMe }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
