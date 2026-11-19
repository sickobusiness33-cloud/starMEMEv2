import { useSyncExternalStore } from 'react';

/**
 * Hash routes: #/live · #/radar?q=…&chain=… · #/intelligence
 * Hash routing keeps deep links working on any static host and needs no
 * server-side fallback.
 */
export type Tab = 'live' | 'radar' | 'intelligence';
export const TABS: readonly Tab[] = ['live', 'radar', 'intelligence'];

export interface Route {
  tab: Tab;
  params: URLSearchParams;
  /** the normalized hash, e.g. "#/radar?q=bonk" — stable identity for effects */
  key: string;
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const path = (q === -1 ? raw : raw.slice(0, q)).replace(/\/+$/, '').toLowerCase();
  const search = q === -1 ? '' : raw.slice(q + 1);
  const tab = (TABS as readonly string[]).includes(path) ? (path as Tab) : 'live';
  const params = new URLSearchParams(search);
  const qs = params.toString();
  return { tab, params, key: `#/${tab}${qs ? `?${qs}` : ''}` };
}

let current: Route = parse(typeof location === 'undefined' ? '' : location.hash);
const listeners = new Set<() => void>();
let keyboardNav = false;

function update(): void {
  const next = parse(location.hash);
  if (next.key === current.key) return;
  current = next;
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', update);
  // Unknown or empty hash → canonical route, without adding a history entry.
  if (location.hash !== current.key) history.replaceState(null, '', current.key);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getRoute = () => current;

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute, getRoute);
}

export function getCurrentRoute(): Route {
  return current;
}

export interface NavigateOpts {
  replace?: boolean;
  /** keyboard-initiated: the UI must switch instantly, with no transition */
  viaKeyboard?: boolean;
}

export function buildHash(tab: Tab, params?: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v);
  const s = qs.toString();
  return `#/${tab}${s ? `?${s}` : ''}`;
}

export function navigate(tab: Tab, params?: Record<string, string | null | undefined>, opts: NavigateOpts = {}): void {
  const hash = buildHash(tab, params);
  if (hash === location.hash) return;
  keyboardNav = opts.viaKeyboard === true;
  if (opts.replace) {
    history.replaceState(null, '', hash);
    update();
  } else {
    location.hash = hash;
    // Sync now rather than on the (async) hashchange: a keyboard or tap switch renders in the
    // same frame as the input. The hashchange that follows sees an unchanged key and no-ops.
    update();
  }
}

/** True once after a keyboard-initiated navigation (read by the tab indicator). */
export function consumeKeyboardNav(): boolean {
  const v = keyboardNav;
  keyboardNav = false;
  return v;
}
