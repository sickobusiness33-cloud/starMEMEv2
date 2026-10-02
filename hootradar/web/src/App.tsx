import { useEffect, useLayoutEffect, useRef } from 'react';
import { Toaster } from 'sonner';
import { TopBar } from './components/TopBar';
import { ConnectionBanner } from './components/ConnectionBanner';
import { goToTab, Tabs } from './components/Tabs';
import { LiveView } from './views/LiveView';
import { RadarView } from './views/RadarView';
import { IntelligenceView } from './views/IntelligenceView';
import { TABS, useRoute, type Tab } from './lib/hash-router';
import { fmtTicker } from './lib/format';
import { useRadar } from './lib/radar';
import { startStream, stopStream } from './lib/stream';
import { useStore } from './store';
import { PHONE_QUERY, useMediaQuery } from './lib/media';

/** keep in sync with --tabbar-mobile-h */
const MOBILE_TABBAR_PX = 58;

export function App() {
  const route = useRoute();
  const mainRef = useRef<HTMLElement>(null);
  const phone = useMediaQuery(PHONE_QUERY);

  // One SSE connection for the whole app, opened once.
  useEffect(() => {
    startStream();
    return () => stopStream();
  }, []);

  useShortcuts();
  useScrollMemory(route.tab);
  useDocumentTitle(route.tab);

  // Toasts sit 16px above whatever is pinned to the bottom edge (the tab bar on phones).
  const aboveTabBar = `calc(${MOBILE_TABBAR_PX + 16}px + env(safe-area-inset-bottom, 0px))`;

  return (
    <div className="app">
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </button>
      <header className="header">
        <TopBar />
        <Tabs active={route.tab} />
        <ConnectionBanner />
      </header>

      <main id="main" className="main" ref={mainRef} tabIndex={-1}>
        {TABS.map((tab) => (
          <div
            key={tab}
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="view"
            hidden={tab !== route.tab}
          >
            {tab === route.tab && <View tab={tab} />}
          </div>
        ))}
      </main>

      <Toaster
        theme="dark"
        position="bottom-right"
        gap={8}
        visibleToasts={3}
        offset={phone ? { bottom: aboveTabBar, right: 16, left: 16 } : 24}
        mobileOffset={{ bottom: aboveTabBar, right: 16, left: 16 }}
        containerAriaLabel="Notifications"
      />
    </div>
  );
}

function View({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'live':
      return <LiveView />;
    case 'radar':
      return <RadarView />;
    case 'intelligence':
      return <IntelligenceView />;
  }
}

/* ───────────── global keyboard shortcuts ───────────── */

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file'].includes(t.type);
  }
  return false;
}

/**
 * 1 / 2 / 3 switch tabs, "/" jumps to the Radar search. Keyboard switches are
 * instant (no indicator slide): they happen hundreds of times a day.
 */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const n = ['1', '2', '3'].indexOf(e.key);
      if (n !== -1) {
        const tab = TABS[n];
        if (!tab) return;
        e.preventDefault();
        goToTab(tab, true);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        goToTab('radar', true);
        useStore.getState().requestRadarFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/* ───────────── per-tab scroll position ───────────── */

/**
 * Each tab keeps its own scroll position (one window scroller, three views).
 * Positions are recorded continuously so the value is the reader's, not the
 * one the browser clamps to while the old view unmounts.
 */
function useScrollMemory(tab: Tab): void {
  const positions = useRef<Record<Tab, number>>({ live: 0, radar: 0, intelligence: 0 });
  const current = useRef(tab);

  useEffect(() => {
    const onScroll = () => {
      positions.current[current.current] = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (current.current === tab) return;
    current.current = tab;
    window.scrollTo({ top: positions.current[tab], behavior: 'instant' });
  }, [tab]);
}

/* ───────────── document title ───────────── */

function useDocumentTitle(tab: Tab): void {
  const radarLabel = useRadar((s) => (s.report?.token ? fmtTicker(s.report.token.symbol) : s.query));
  useEffect(() => {
    if (tab === 'radar') document.title = radarLabel ? `Radar · ${radarLabel} — HootRadar` : 'Radar — HootRadar';
    else if (tab === 'intelligence') document.title = 'Intelligence — HootRadar';
    else document.title = 'HootRadar — live crypto intelligence';
  }, [tab, radarLabel]);
}
