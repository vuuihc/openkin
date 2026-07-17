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
export function IconUsage(p: IconProps) {
  return base(
    p,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
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
