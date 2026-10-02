/** Clipboard write with a legacy fallback for non-secure contexts (LAN dev on a phone). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied or unsupported → fall through to the legacy path
  }
  // select() moves focus into the textarea; give it back afterwards so a keyboard
  // user who copied an address keeps their place in the tab order.
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.fontSize = '16px'; // no iOS zoom on focus
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    // iOS Safari does not select a readonly field through select() alone
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    prev?.focus({ preventScroll: true });
  }
}
