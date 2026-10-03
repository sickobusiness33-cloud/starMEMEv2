import { toast } from 'sonner';
import type { NewsArticle } from '@shared/types';
import { getChainMeta } from './chains';
import { navigate } from './hash-router';
import { fmtTicker } from './format';
import { useStore } from '../store';
import { IconCheck, IconClose } from '../components/Icons';

/**
 * Toasts are headless (`toast.custom`): our JSX, Sonner's positioning,
 * stacking, swipe and hidden-tab timer pausing. One <Toaster /> lives at the root.
 * Sonner's toaster <section> is already a polite live region, so the toast bodies
 * carry no role of their own (a nested status/alert gets read twice).
 */

/**
 * Open a story in LIVE (toast "View", tape row): switch tab, bring it in, expand and
 * focus it. A failure says so instead of leaving the reader on a tab that did nothing.
 */
export async function openArticle(id: string): Promise<void> {
  navigate('live');
  const res = await useStore.getState().focusArticle(id);
  if (!res.ok) notifyError(res.message);
}

function BreakingToast({ id, article }: { id: string | number; article: NewsArticle }) {
  const chain = getChainMeta(article.chain);
  const view = () => {
    toast.dismiss(id);
    void openArticle(article.id);
  };
  return (
    <div className="toast toast--breaking">
      <div className="toast__row">
        <span className="tag tag--breaking">Breaking</span>
        <span className="toast__ticker mono">{fmtTicker(article.symbol)}</span>
        <span className="toast__chain mono">
          <span className="dot" style={{ ['--dot' as string]: chain.color }} aria-hidden="true" />
          {chain.short}
        </span>
        <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => toast.dismiss(id)}>
          <IconClose size={12} />
        </button>
      </div>
      <p className="toast__text">{article.headline}</p>
      <div className="toast__actions">
        <button type="button" className="btn btn--sm btn--primary" onClick={view}>
          View
        </button>
        <span className="toast__score mono">Score {article.score}</span>
      </div>
    </div>
  );
}

export function notifyBreaking(article: NewsArticle): void {
  toast.custom((id) => <BreakingToast id={id} article={article} />, {
    id: `breaking-${article.id}`,
    duration: 9_000,
  });
}

export function notifyCopied(what: string): void {
  toast.custom(
    () => (
      <div className="toast toast--small">
        <IconCheck size={13} className="pos" />
        <span>{what} copied</span>
      </div>
    ),
    { id: 'copied', duration: 1_800 },
  );
}

export function notifyError(message: string): void {
  toast.custom(
    () => (
      <div className="toast toast--small">
        <span className="dot" style={{ ['--dot' as string]: 'var(--red)' }} aria-hidden="true" />
        <span className="sr-only">Error: </span>
        <span>{message}</span>
      </div>
    ),
    { id: `error-${message}`, duration: 4_000 },
  );
}
