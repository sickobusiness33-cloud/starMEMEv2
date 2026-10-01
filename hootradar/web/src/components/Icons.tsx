import type { SVGProps } from 'react';

/** 16px stroke icons. Decorative: always aria-hidden; the control carries the label. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5A1 1 0 0 0 9.5 2.5H3.5A1 1 0 0 0 2.5 3.5v6a1 1 0 0 0 1 1h2" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5Z" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 3 10 10M13 3 3 13" strokeWidth={1.4} />
  </Svg>
);

export const IconTelegram = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3 2.5 7.4l4 1.3 1.3 4.3 2.2-2.6 3 2.1L13.5 3Z" />
    <path d="m6.5 8.7 7-5.7" />
  </Svg>
);

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5" />
  </Svg>
);

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 13.5h11M4.5 11V7M8 11V4M11.5 11V8.5" />
  </Svg>
);

export const IconBlocks = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.5 13 5v6l-5 2.5L3 11V5l5-2.5ZM3 5l5 2.5L13 5M8 7.5v6" />
  </Svg>
);

export const IconPaper = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5.5L12 5v8.5H4v-11Z" />
    <path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" />
  </Svg>
);

export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3.5A1 1 0 0 1 4 2.5h8.5v9H4a1 1 0 0 0-1 1v-9ZM3 12.5a1 1 0 0 0 1 1h8.5" />
  </Svg>
);

export const IconLive = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.4 12.6a6.5 6.5 0 0 1 0-9.2M12.6 3.4a6.5 6.5 0 0 1 0 9.2" />
  </Svg>
);

export const IconRadar = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 8 12 4" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 2.5 5.5 3L8 8.5l-5.5-3L8 2.5Z" />
    <path d="m2.5 8.5 5.5 3 5.5-3M2.5 11 8 14l5.5-3" />
  </Svg>
);
