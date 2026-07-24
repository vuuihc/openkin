/** Lightweight stroke icons matching the design mockups (24 viewBox). */

import type { ReactNode } from "react";

type IconProps = {
  className?: string;
  size?: number;
  strokeWidth?: number;
};

function base(
  {
    className,
    size = 16,
    strokeWidth = 1.7,
  }: IconProps,
  paths: ReactNode,
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths}
    </svg>
  );
}

export function IconPlus(p: IconProps) {
  return base(p, <path d="M12 5v14M5 12h14" />);
}
export function IconInbox(p: IconProps) {
  return base(
    p,
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>,
  );
}
export function IconTasks(p: IconProps) {
  return base(
    p,
    <>
      <path d="M3 3v18h18" />
      <path d="M18 17V9M13 17V5M8 17v-3" />
    </>,
  );
}
export function IconArtifacts(p: IconProps) {
  return base(
    p,
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M8 7h8M8 11h6" />
    </>,
  );
}
export function IconProjects(p: IconProps) {
  return base(
    p,
    <>
      <path d="M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2" />
    </>,
  );
}
export function IconUsage(p: IconProps) {
  return base(
    p,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
  );
}
export function IconAgents(p: IconProps) {
  return base(
    p,
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  );
}
export function IconSettings(p: IconProps) {
  return base(
    p,
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  );
}
export function IconSearch(p: IconProps) {
  return base(
    p,
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>,
  );
}
export function IconPanel(p: IconProps) {
  return base(
    p,
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </>,
  );
}
export function IconCheck(p: IconProps) {
  return base(p, <path d="M20 6 9 17l-5-5" />);
}
export function IconCopy(p: IconProps) {
  return base(
    p,
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>,
  );
}
export function IconShare(p: IconProps) {
  return base(
    p,
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5" />
    </>,
  );
}
export function IconDownload(p: IconProps) {
  return base(p, <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>);
}
export function IconAlert(p: IconProps) {
  return base(
    p,
    <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />,
  );
}
export function IconTerminal(p: IconProps) {
  return base(p, <path d="M4 17l6-6-6-6M12 19h8" />);
}
export function IconSend(p: IconProps) {
  return base(p, <path d="M12 19V5M5 12l7-7 7 7" />);
}
export function IconStop(p: IconProps) {
  return base(p, <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />);
}
export function IconBack(p: IconProps) {
  return base(p, <path d="M15 18l-6-6 6-6" />,);
}
export function IconFile(p: IconProps) {
  return base(
    p,
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>,
  );
}
export function IconFolder(p: IconProps) {
  return base(
    p,
    <>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
      <path d="M3 9h18" />
    </>,
  );
}
export function IconChevron(p: IconProps) {
  return base(p, <path d="M9 18l6-6-6-6" />);
}
export function IconImage(p: IconProps) {
  return base(
    p,
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="M21 15l-5-5L5 21" />
    </>,
  );
}
export function IconX(p: IconProps) {
  return base(p, <path d="M18 6 6 18M6 6l12 12" />);
}
export function IconTrash(p: IconProps) {
  return base(
    p,
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>,
  );
}
export function IconKin(p: IconProps) {
  return base(
    { ...p, strokeWidth: p.strokeWidth ?? 1.6 },
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />,
  );
}
export function IconStar(p: IconProps) {
  return base(
    p,
    <path d="M12 3l2.5 6L21 9l-5 4 2 7-6-4-6 4 2-7-5-4 6.5 0z" />,
  );
}

export function IconPin(p: IconProps) {
  return base(
    p,
    <path d="M12 17v5M9 3h6l-1 7h3l-5 5-5-5h3L9 3z" />,
  );
}

export function IconSort(p: IconProps) {
  return base(
    p,
    <>
      <path d="M4 6h10M4 12h7M4 18h4" />
      <path d="M18 5v14M15 16l3 3 3-3" />
    </>,
  );
}

export function IconExternal(p: IconProps) {
  return base(
    p,
    <>
      <path d="M14 4h6v6" />
      <path d="M10 14 20 4" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </>,
  );
}

export function IconArchive(p: IconProps) {
  return base(
    p,
    <>
      <path d="M3 7h18v2H3z" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </>,
  );
}

export function IconMore(p: IconProps) {
  return base(
    p,
    <>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </>,
  );
}
