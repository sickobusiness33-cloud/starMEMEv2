import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { consumeKeyboardNav, navigate, TABS, type Tab } from '../lib/hash-router';
import { currentRadarParams } from '../lib/radar';
import { useStore } from '../store';
import { ChainChips } from './ChainChips';
import { IconLayers, IconLive, IconRadar } from './Icons';

const LABEL: Record<Tab, string> = { live: 'Live', radar: 'Radar', intelligence: 'Intelligence' };
const ICON: Record<Tab, typeof IconLive> = { live: IconLive, radar: IconRadar, intelligence: IconLayers };

/** CSS width of the indicator before scaleX — keep in sync with .tabs__indicator */
const INDICATOR_BASE = 100;

export function goToTab(tab: Tab, viaKeyboard = false): void {
  navigate(tab, tab === 'radar' ? currentRadarParams() : undefined, { viaKeyboard });
}

export function Tabs({ active }: { active: Tab }) {
  const listRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const buffered = useStore((s) => s.buffered.length);

  // The underline slides between tabs (transform only). First placement and
  // keyboard switches are instant: no animation on keyboard-initiated actions.
  useLayoutEffect(() => {
    const list = listRef.current;
    const ind = indicatorRef.current;
    if (!list || !ind) return;
    const place = (instant: boolean) => {
      const btn = list.querySelector<HTMLElement>(`[data-tab="${active}"]`);
      if (!btn) return;
      if (instant) ind.dataset.instant = '';
      ind.style.transform = `translateX(${btn.offsetLeft}px) scaleX(${btn.offsetWidth / INDICATOR_BASE})`;
      if (instant) {
        void ind.offsetWidth; // commit the jump before transitions come back
        delete ind.dataset.instant;
      }
    };
    place(!placed.current || consumeKeyboardNav());
    placed.current = true;
    // fonts loading / breakpoint changes move the tabs: follow without animating
    const ro = new ResizeObserver(() => place(true));
    ro.observe(list);
    return () => ro.disconnect();
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(active);
    let next: Tab | undefined;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    goToTab(next, true);
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <nav className="tabbar" aria-label="Sections">
      <div className="tabbar__inner">
        <div className="tabs" role="tablist" aria-label="HootRadar sections" ref={listRef} onKeyDown={onKeyDown}>
          {TABS.map((tab, i) => {
            const Icon = ICON[tab];
            const selected = tab === active;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`tab-${tab}`}
                data-tab={tab}
                aria-selected={selected}
                aria-controls={`panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                className={clsx('tab', selected && 'is-active')}
                onClick={() => goToTab(tab)}
                title={`${LABEL[tab]} (${i + 1})`}
              >
                <Icon size={16} className="tab__icon" />
                <span className="tab__label">{LABEL[tab]}</span>
                {tab === 'live' && !selected && buffered > 0 && (
                  <span className="tab__badge" aria-label={`${buffered} new`}>
                    {buffered > 99 ? '99+' : buffered}
                  </span>
                )}
                <kbd className="tab__kbd" aria-hidden="true">
                  {i + 1}
                </kbd>
              </button>
            );
          })}
          <span className="tabs__indicator" ref={indicatorRef} aria-hidden="true" data-instant="" />
        </div>
        <ChainChips className="tabbar__chains" />
      </div>
    </nav>
  );
}
