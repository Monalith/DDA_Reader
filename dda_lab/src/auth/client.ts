// Auth client for the hosted app (bridge/auth.py). AGENT A implements the UI around it.
// Contract other modules rely on: `AuthUser`, `getAuth()`, `useAuth()`, `logout()`.
// Same-origin in production; in dev (vite :5190) the bridge is on 127.0.0.1:8777.
import { useEffect, useState } from 'react';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
}

export interface AuthState {
  loading: boolean;
  authEnabled: boolean;
  user: AuthUser | null;
}

export function apiBase(): string {
  return location.port === '5190' ? 'http://127.0.0.1:8777' : '';
}

let state: AuthState = { loading: true, authEnabled: false, user: null };
const listeners = new Set<() => void>();
let fetched: Promise<AuthState> | null = null;

function setState(next: AuthState): void {
  state = next;
  for (const l of listeners) l();
}

/** Fetch /api/auth/me once (cached); offline / no bridge → auth disabled, no user. */
export function getAuth(force = false): Promise<AuthState> {
  if (fetched && !force) return fetched;
  fetched = fetch(`${apiBase()}/api/auth/me`, { credentials: 'include' })
    .then(async (r) => {
      const j = (await r.json()) as { user: AuthUser | null; authEnabled: boolean };
      setState({ loading: false, authEnabled: !!j.authEnabled, user: j.user });
      return state;
    })
    .catch(() => {
      setState({ loading: false, authEnabled: false, user: null });
      return state;
    });
  return fetched;
}

export function useAuth(): AuthState {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    void getAuth();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

export async function logout(): Promise<void> {
  await fetch(`${apiBase()}/api/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
  setState({ ...state, user: null });
}
