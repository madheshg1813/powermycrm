'use client';
import { useEffect } from 'react';

/** Registers the service worker in production builds so the app can be installed on phones and desktops. */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
