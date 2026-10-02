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
 */

function BreakingToast({ id, article }: { id: string | number; article: NewsArticle }) {
  const chain = getChainMeta(article.chain);
  const view = () => {
    toast.dismiss(id);
    navigate('live');
    void useStore.getState().focusArticle(article.id);
  };
  return (
    <div className="toast toast--breaking" role="status">
      <div className="toast__row">
        <span className="tag tag--breaking">Breaking</span>
        <span className="toast__ticker mono">{fmtTicker(article.symbol)}</span>
        <span className="toast__chain mono">
          <span className="dot" style={{ ['--dot' as string]: chain.color }} />
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
      <div className="toast toast--small" role="status">
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
      <div className="toast toast--small" role="alert">
        <span className="dot" style={{ ['--dot' as string]: 'var(--red)' }} />
        <span>{message}</span>
      </div>
    ),
    { id: `error-${message}`, duration: 4_000 },
  );
}
