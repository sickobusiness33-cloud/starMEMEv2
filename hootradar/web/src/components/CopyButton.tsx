import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { copyText } from '../lib/clipboard';
import { notifyCopied, notifyError } from '../lib/notify';
import { IconCheck, IconCopy } from './Icons';

interface Props {
  text: string;
  /** what was copied, for the confirmation toast ("Contract address") */
  what: string;
  /** visible label; omitted → icon-only button with aria-label */
  label?: string;
  className?: string;
}

/** Copy → Sonner confirmation + a 1.4 s check state on the button itself (state indication). */
export function CopyButton({ text, what, label, className }: Props) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = async () => {
    const ok = await copyText(text);
    if (!ok) {
      notifyError('Copy failed — select the text manually');
      return;
    }
    notifyCopied(what);
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1_400);
  };

  return (
    <button
      type="button"
      className={clsx('btn btn--sm copy-btn', !label && 'btn--icon', className)}
      onClick={onClick}
      aria-label={label ? undefined : `Copy ${what.toLowerCase()}`}
      title={label ? undefined : `Copy ${what.toLowerCase()}`}
      data-done={done || undefined}
    >
      <span className="copy-btn__icons" aria-hidden="true">
        <IconCopy size={12} className="copy-btn__copy" />
        <IconCheck size={12} className="copy-btn__check" />
      </span>
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}
