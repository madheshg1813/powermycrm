'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: any,
  ) {
    super(message);
  }
}

// The access token lives in memory only. The httpOnly refresh cookie restores it after a reload.
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(t: string | null) {
  accessToken = t;
}

export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return false;
      accessToken = (await r.json()).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Options = { method?: string; body?: unknown; text?: boolean };

export async function api<T = any>(path: string, opts: Options = {}, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      headers: {
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 401 && !retried && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) {
    if (await refreshSession()) return api<T>(path, opts, true);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('pmc:signed-out'));
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message = Array.isArray(data?.message) ? data.message[0] : data?.message;
    throw new ApiError(res.status, message || (res.status >= 500 ? 'Something went wrong on our side. Please try again.' : `Request failed (${res.status})`), data);
  }
  return (opts.text ? res.text() : res.json()) as Promise<T>;
}

/** Fetches a file through the API with the session token and hands it to the browser as a download. */
export async function downloadFile(path: string, filename: string) {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (res.status === 401 && (await refreshSession())) return downloadFile(path, filename);
  if (!res.ok) throw new ApiError(res.status, 'Could not download the file');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** Uploads one file as multipart form data. */
export async function uploadFile<T = any>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file, file.name);
  const res = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, body: form });
  if (res.status === 401 && (await refreshSession())) return uploadFile<T>(path, file, field);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.message || (res.status === 413 ? 'The file is too large (10 MB maximum)' : `Upload failed (${res.status})`), data);
  }
  return res.json() as Promise<T>;
}

/** Loads a GET endpoint and keeps it in state. Pass null to skip. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(e as ApiError);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
