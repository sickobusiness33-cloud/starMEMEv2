/** HootRadar mark: an owl's eyes drawn as two radar scopes. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo-mark">
      <path d="M5.5 8.5 10.5 12M26.5 8.5 21.5 12" stroke="var(--green)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="10.6" cy="18" r="5.4" fill="none" stroke="var(--green)" strokeWidth="2.2" />
      <circle cx="21.4" cy="18" r="5.4" fill="none" stroke="var(--green)" strokeWidth="2.2" />
      <circle cx="10.6" cy="18" r="2" fill="var(--green)" />
      <circle cx="21.4" cy="18" r="2" fill="var(--cyan)" />
    </svg>
  );
}
