import { useEffect } from 'react';
import { create } from 'zustand';
import type { QuantLeadersResponse, QuantLibraryResponse } from '@shared/types';
import { api, errorMessage, isAbortError } from './api';

/**
 * INTELLIGENCE data: the methodology library (static per server build, fetched
 * once per session) and the live leaders (recomputed by the server every 15 s;
 * we poll every 30 s while the tab is open and visible).
 */

export const LEADERS_REFRESH_MS = 30_000;

type Load<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; data: T | null; error: string | null; at: number | null };

interface QuantState {
  library: Load<QuantLibraryResponse>;
  leaders: Load<QuantLeadersResponse>;
  loadLibrary: (force?: boolean) => void;
  loadLeaders: () => void;
}

const idle = <T,>(): Load<T> => ({ status: 'idle', data: null, error: null, at: null });

let libraryCtrl: AbortController | null = null;
let leadersCtrl: AbortController | null = null;

export const useQuant = create<QuantState>()((set, get) => ({
  library: idle(),
  leaders: idle(),

  loadLibrary: (force = false) => {
    const cur = get().library;
    if (cur.status === 'loading' || (cur.status === 'ready' && !force)) return;
    libraryCtrl?.abort();
    const ctrl = new AbortController();
    libraryCtrl = ctrl;
    set({ library: { ...cur, status: 'loading', error: null } });
    api
      .quantLibrary(ctrl.signal)
      .then((data) => set({ library: { status: 'ready', data, error: null, at: Date.now() } }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        set({ library: { ...get().library, status: 'error', error: errorMessage(e) } });
      });
  },

  loadLeaders: () => {
    if (get().leaders.status === 'loading') return;
    leadersCtrl?.abort();
    const ctrl = new AbortController();
    leadersCtrl = ctrl;
    // keep the last good board on screen while refreshing
    set({ leaders: { ...get().leaders, status: 'loading', error: null } });
    api
      .quantLeaders(ctrl.signal)
      .then((data) => set({ leaders: { status: 'ready', data, error: null, at: Date.now() } }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        const prev = get().leaders;
        set({ leaders: { ...prev, status: prev.data ? 'ready' : 'error', error: errorMessage(e) } });
      });
  },
}));

/** Mount-scoped polling: fetch now, every 30 s while visible, and on return to the tab when stale. */
export function useQuantPolling(): void {
  useEffect(() => {
    const { loadLibrary, loadLeaders } = useQuant.getState();
    loadLibrary();
    const at = useQuant.getState().leaders.at;
    if (at === null || Date.now() - at > LEADERS_REFRESH_MS / 2) loadLeaders();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') useQuant.getState().loadLeaders();
    }, LEADERS_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const last = useQuant.getState().leaders.at;
      if (last === null || Date.now() - last >= LEADERS_REFRESH_MS) useQuant.getState().loadLeaders();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      leadersCtrl?.abort();
      leadersCtrl = null;
      const l = useQuant.getState().leaders;
      if (l.status === 'loading') useQuant.setState({ leaders: { ...l, status: l.data ? 'ready' : 'idle' } });
    };
  }, []);
}
