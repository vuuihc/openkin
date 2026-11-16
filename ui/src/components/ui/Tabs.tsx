import {
  isValidElement,
  useLayoutEffect,
  useRef,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Tab as AstryxTab, TabList as AstryxTabList } from "@astryxdesign/core";
import { useT } from "../../i18n/react";
import { IconX } from "../icons";
import Button from "./Button";

export type TabItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Status dot/badge; its text must be part of the tab's accessible name (TASTE 18). */
  mark?: ReactNode;
  closeable?: boolean;
  disabled?: boolean;
};

export type TabsProps = {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Delete closes the focused closeable tab and hands focus to its neighbour. */
  onClose?: (id: string) => void;
  /** Alt+Arrow moves the tab itself; the contract is a one-step delta. */
  onMove?: (id: string, delta: -1 | 1) => void;
  variant?: "tabs" | "segmented";
  ariaLabel: string;
  className?: string;
};

/** The Astryx surface this facade composes; the cast is the external boundary. */
type AstryxTabListProps = {
  value: string;
  onChange: (...args: unknown[]) => void;
  role?: string;
  "aria-label"?: string;
  className?: string;
  children?: ReactNode;
};

type AstryxTabProps = {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  endContent?: ReactNode;
  disabled?: boolean;
  isDisabled?: boolean;
  "aria-label"?: string;
};

const TabList = AstryxTabList as unknown as ComponentType<AstryxTabListProps>;
const Tab = AstryxTab as unknown as ComponentType<AstryxTabProps>;

const VARIANT_CLASS: Record<NonNullable<TabsProps["variant"]>, string> = {
  tabs: "flex items-center overflow-x-auto",
  segmented: "inline-flex items-center gap-1 rounded-xl bg-kin-elevated/50 p-1",
};

/** A mark's words, walked out for the tab's accessible name (TASTE 18). */
function markText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markText).filter(Boolean).join(" ");
  if (isValidElement<{ "aria-label"?: string; alt?: string; children?: ReactNode }>(node)) {
    const props = node.props;
    if (typeof props["aria-label"] === "string" && props["aria-label"]) return props["aria-label"];
    if (typeof props.alt === "string" && props.alt) return props.alt;
    return markText(props.children);
  }
  return "";
}

/** The tab that carries the strip's single tab stop. */
function stopIdOf(items: readonly TabItem[], value: string): string | null {
  const selected = items.find((item) => item.id === value && !item.disabled);
  if (selected) return selected.id;
  return items.find((item) => !item.disabled)?.id ?? null;
}

/** Who takes focus when a tab closes: the next usable one, else the previous. */
function neighbourTabOf(items: readonly TabItem[], id: string): string | null {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const rest = items.filter((item) => item.id !== id && !item.disabled);
  if (rest.length === 0) return null;
  const right = items.slice(index + 1).find((item) => item.id !== id && !item.disabled);
  return right?.id ?? rest[rest.length - 1]?.id ?? null;
}

/**
 * The console's tab strip, over Astryx `TabList`/`Tab`. One API expresses the
 * four hand-written strips (sessions, settings, terminal, workspace); Kin owns
 * the contract — controlled value, one tab stop, wrapping arrows, Home/End,
 * Delete-close with focus handoff, Alt+Arrow reorder — and Astryx owns the
 * surface. It is not an overlay (TASTE 16). Panels, order, the 12-tab cap and
 * storage are the caller's.
 */
export default function Tabs({
  items,
  value,
  onChange,
  onClose,
  onMove,
  variant = "tabs",
  ariaLabel,
  className,
}: TabsProps) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  // Read at event time: a close removes an item, so the successor's index is
  // only knowable after the caller's re-render.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const tabNodes = (): HTMLElement[] =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? []);

  const focusTab = (id: string) => {
    window.requestAnimationFrame(() => {
      const index = itemsRef.current.findIndex((item) => item.id === id);
      if (index >= 0) tabNodes()[index]?.focus();
    });
  };

  const select = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item || item.disabled || item.id === value) return;
    onChange(item.id);
  };

  /** Astryx may hand the value first or second; accept either at the boundary. */
  const handleChange = (...args: unknown[]) => {
    const next = args.find((arg): arg is string => typeof arg === "string");
    if (next !== undefined) select(next);
  };

  /** Capture phase: one keystroke is one move, even if Astryx also answers. */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const key = event.key;
    const isArrow = key === "ArrowLeft" || key === "ArrowRight";
    const isEdge = key === "Home" || key === "End";
    const isClose = key === "Delete" || key === "Backspace";
    if (!isArrow && !isEdge && !isClose) return;

    const target = event.target as HTMLElement;
    const tabElement = target.closest<HTMLElement>("[role=tab]");
    const domIndex = tabElement ? tabNodes().indexOf(tabElement) : -1;
    const currentIndex = domIndex >= 0 ? domIndex : items.findIndex((item) => item.id === value);
    const current = items[currentIndex];
    if (!current) return;

    if (isClose) {
      if (!current.closeable || !onClose) return;
      const heir = neighbourTabOf(items, current.id);
      onClose(current.id);
      if (heir) focusTab(heir);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (isArrow && event.altKey) {
      // Alt moves the tab, the plain arrow moves the cursor: the same gesture
      // at two scopes. A reorder must not move the reader.
      if (!onMove) return;
      onMove(current.id, key === "ArrowLeft" ? -1 : 1);
      focusTab(current.id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    let nextIndex: number | null = null;
    if (isEdge) {
      const enabled = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !item.disabled);
      const found = key === "Home" ? enabled[0] : enabled[enabled.length - 1];
      nextIndex = found ? found.index : null;
    } else {
      const direction = key === "ArrowRight" ? 1 : -1;
      for (let step = 1; step <= items.length; step += 1) {
        const index =
          ((currentIndex + direction * step) % items.length + items.length) % items.length;
        if (items[index] && !items[index].disabled) {
          nextIndex = index;
          break;
        }
      }
    }

    const next = nextIndex === null ? undefined : items[nextIndex];
    if (!next) return;
    select(next.id);
    focusTab(next.id);
    event.preventDefault();
    event.stopPropagation();
  };

  /** One tab stop after every render; disabled tabs are never stops. */
  useLayoutEffect(() => {
    const nodes = tabNodes();
    if (nodes.length === 0) return;
    const stop = stopIdOf(items, value);
    items.forEach((item, index) => {
      const node = nodes[index];
      if (!node) return;
      node.tabIndex = !item.disabled && item.id === stop ? 0 : -1;
      if (item.disabled) node.setAttribute("aria-disabled", "true");
      else node.removeAttribute("aria-disabled");
    });
  });

  return (
    <div
      ref={rootRef}
      className={["min-w-0", className].filter(Boolean).join(" ")}
      onKeyDownCapture={handleKeyDown}
    >
      <TabList
        value={value}
        onChange={handleChange}
        role="tablist"
        aria-label={ariaLabel}
        className={VARIANT_CLASS[variant]}
      >
        {items.map((item) => {
          const state = markText(item.mark);
          return (
            <Tab
              key={item.id}
              value={item.id}
              label={item.label}
              icon={item.icon}
              // `disabled` is the DOM word and `isDisabled` Astryx's; a disabled
              // tab must be inert either way.
              disabled={item.disabled}
              isDisabled={item.disabled}
              // The mark's words join the tab's name (TASTE 18).
              aria-label={state ? `${item.label}, ${state}` : undefined}
              endContent={
                item.mark || (item.closeable && onClose) ? (
                  <span className="flex items-center gap-1">
                    {item.mark}
                    {item.closeable && onClose ? (
                      <Button
                        variant="quiet"
                        className="-my-1 flex h-11 w-11 items-center justify-center rounded p-0 text-kin-muted hover:text-kin-text sm:h-6 sm:w-6"
                        aria-label={tr("tabs.close", { name: item.label })}
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(item.id);
                        }}
                      >
                        <IconX size={12} />
                      </Button>
                    ) : null}
                  </span>
                ) : undefined
              }
            />
          );
        })}
      </TabList>
    </div>
  );
}
