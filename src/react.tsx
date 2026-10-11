'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KaraiClient, type KaraiConfig, type KaraiSession } from './client';

const STORAGE_KEY = 'karai:session';

type KaraiContextValue = {
  client: KaraiClient;
  session: KaraiSession | null;
  status: 'idle' | 'working' | 'ready';
  error: string | null;
  createWallet: (username: string) => Promise<void>;
  login: () => Promise<void>;
  logout: () => void;
};

const KaraiContext = createContext<KaraiContextValue | null>(null);

/** `storageKey`: where the session is saved. Pages of different apps on one origin each need their own. */
export function KaraiProvider({
  config,
  storageKey = STORAGE_KEY,
  children,
}: {
  config: KaraiConfig;
  storageKey?: string;
  children: ReactNode;
}) {
  const client = useMemo(() => new KaraiClient(config), [config]);
  const [session, setSession] = useState<KaraiSession | null>(null);
  const [status, setStatus] = useState<KaraiContextValue['status']>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        setSession(JSON.parse(saved) as KaraiSession);
        setStatus('ready');
      }
    } catch {
      // storage unavailable: user signs in again
    }
  }, [storageKey]);

  const run = useCallback(async (action: () => Promise<KaraiSession>) => {
    setStatus('working');
    setError(null);
    try {
      const next = await action();
      setSession(next);
      setStatus('ready');
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // non-persistent session is fine
      }
    } catch (e) {
      setError((e as Error).message);
      setStatus('idle');
    }
  }, [storageKey]);

  const value = useMemo<KaraiContextValue>(
    () => ({
      client,
      session,
      status,
      error,
      createWallet: (username) => run(() => client.createWallet(username)),
      login: () => run(() => client.login()),
      logout: () => {
        setSession(null);
        setStatus('idle');
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // ignore
        }
      },
    }),
    [client, session, status, error, run, storageKey],
  );

  return <KaraiContext.Provider value={value}>{children}</KaraiContext.Provider>;
}

export function useKarai(): KaraiContextValue {
  const ctx = useContext(KaraiContext);
  if (!ctx) throw new Error('useKarai must be used inside <KaraiProvider>');
  return ctx;
}

/** Drop-in sign-up / sign-in with a passkey. Style it with `className`. */
export function LoginButton({
  className,
  username = 'Karai user',
  labels = { create: 'Continue with passkey', login: 'I already have a wallet', working: 'Waiting for passkey…' },
}: {
  className?: string;
  username?: string;
  labels?: { create: string; login: string; working: string };
}) {
  const { session, status, createWallet, login } = useKarai();
  if (session) return null;
  const busy = status === 'working';
  return (
    <div className={className} data-karai-login>
      <button type="button" disabled={busy} onClick={() => createWallet(username)} data-variant="primary">
        {busy ? labels.working : labels.create}
      </button>
      <button type="button" disabled={busy} onClick={login} data-variant="secondary">
        {labels.login}
      </button>
    </div>
  );
}
