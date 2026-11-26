import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Approval } from "../../api/client";
import { useT } from "../../i18n/react";
import { usePanelColumnOpen, usePanelOpen } from "../../lib/panelPresence";
import ErrorBoundary from "../ErrorBoundary";
import Button from "../ui/Button";
import ApprovalCard from "./ApprovalCard";

type Decision = "approved" | "denied";

/** The part of a `DOMRect` the overlap test needs. */
type Rect = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">;

/**
 * Whether two laid-out boxes share any area.
 *
 * Touching edges are not an overlap: a row that ends exactly where the card
 * begins is fully clickable. A box with no area is not on screen at all — a
 * conversation kept mounted behind `display:none` reports 0×0 — and must not
 * count as covered.
 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

type Props = {
  /** Waiting approvals, in the order the shared resource publishes them. */
  approvals: Approval[];
  /** What the task behind an approval is called, for saying who is blocked. */
  titleFor: (taskId: string) => string;
  busy: Record<string, Decision | undefined>;
  onDecide: (id: string, decision: Decision) => void;
  onOpenTask: (taskId: string) => void;
  /** The list page's footer and new-chat button are on screen, so the card
   *  has to clear them. */
  raised: boolean;
  /** The route, so a measurement taken on one screen is redone on the next. */
  screenKey: string;
  /**
   * This route has a composer pinned to the bottom. The band is marked only by
   * the pane the reader is looking at, and a cold load draws it after the
   * shell, so on these routes the card waits for it instead of guessing.
   */
  expectsBottomChrome: boolean;
  onOpenPath?: (path: string) => void;
};

function ApprovalStatus(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="status" aria-live="polite" />;
}

/**
 * The one pending approval that is not already on screen, floating.
 *
 * It shows the approval that has been waiting longest, not the newest: an agent
 * that stopped twenty minutes ago has been stopped for twenty minutes, and a
 * card that always shows the latest arrival is a queue that starves. The rest
 * are counted in the strip above it — a reader can answer this one, or open the
 * task and deal with the queue where the transcript explains it.
 *
 * The card itself is `ApprovalCard`, the same one the transcript uses. It is the decision surface, with the diff and the buttons; this
 * component only decides where it sits and which one it shows.
 */
export default function FloatingApproval({
  approvals,
  titleFor,
  busy,
  onDecide,
  onOpenTask,
  raised,
  screenKey,
  expectsBottomChrome,
  onOpenPath,
}: Props) {
  const tr = useT();
  // One topmost surface per screen: while a visible panel (the file viewer, the
  // PR panel) is open, the panel is what the reader is reading and the card is
  // not mounted at all. The strip below still names the blocked task, so the
  // approval never goes silent. A panel that is mounted but hidden does not
  // register — see `lib/panelPresence`.
  const panelOpen = usePanelOpen();
  // A panel in its column leaves the conversation on screen; that is the only
  // shape whose right edge the strip has to stay clear of.
  const panelColumn = usePanelColumnOpen();
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Answering unmounts the card that held focus. A keyboard user would be
  // dropped to the document body, mid-queue, with nothing to tab from. The
  // decision is kept, not just a flag: a reader who denied one request must
  // not land on *Approve* for the next, one reflexive Enter away from
  // approving what they were declining.
  const keepFocus = useRef<Decision | null>(null);
  // How far the page's own bottom furniture reaches up the screen: the
  // composer, and the strip above it that says how many items are waiting. On
  // a conversation that band is ~120px and grows with attachments, so a fixed
  // offset either covers the input or floats absurdly high above it. Measured
  // instead, from an element the page marks — see `data-kin-bottom-chrome`.
  const [bottom, setBottom] = useState<number | null>(null);
  // Whether the decision card would cover a changed-file row the reader can
  // click. The card floats in the same right-hand column a transcript draws
  // its round evidence rows in, and the evidence card is open by default: on
  // an ordinary conversation the `notes.md` row sat under the card, so the tap
  // meant for "open the diff" landed on the approval instead. When the card
  // would cover a row it is not mounted at all and the strip above is the
  // whole surface — the same rule a phone tab root and an open panel already
  // follow. The evidence card collapsing, its rows scrolling out of the card's
  // box, or the conversation being hidden brings the card back.
  //
  // Reading content (`[data-kin-reading]`: markdown table cells, the draft's
  // project summary) follows the same rule: the card is not mounted while it
  // would cover something the reader is reading.
  const [covered, setCovered] = useState(false);
  // Whether the *strip itself* would cover reading content or a conversation
  // row. The strip is not a fallback that always gets to stay: its pill floats
  // over the same column, and on a table it ate a cell centre the decision card
  // had already yielded. On the phone's conversation list it came to rest over
  // the last row and took its tap. When the pill is over either, nothing of the
  // surface is mounted on that screen. The approval is not lost — the list row
  // carries the count and the needs-you dot, and opening the conversation shows
  // the inline card.
  const [hidden, setHidden] = useState(false);
  // The whole floating surface's box — the strip *and* the card — remembered
  // across the strip-only render it causes: the card itself is gone while the
  // strip shows, and measuring the strip alone would find nothing under it,
  // mount the card again, and cover the row — a visible flicker on every
  // measurement. The strip is part of the box because the card pushes it up:
  // even when the card's own bottom edge clears a row, the pill above it can
  // sit on the row's centre and take the tap. The height is the part the strip
  // render loses; the right-hand gap comes from the container's CSS and stays
  // valid across a resize.
  const expandedBox = useRef<{
    id: string;
    height: number;
    rightGap: number;
    width: number;
  } | null>(null);
  // Remember the pill's actual offset: removing the card moves the strip down.
  // Reconstructing it at the expanded top would alternate hidden and visible
  // when only the collapsed strip overlaps a cell, until React throws #185.
  const stripBox = useRef<{
    id: string;
    height: number;
    rightGap: number;
    width: number;
    bottomGap: number;
    /** Where the pill's bottom sat from the viewport's: a raised surface's
     *  bottom carries the safe-area inset, which the numeric fallback cannot. */
    bottomFromViewport: number;
  } | null>(null);

  // The oldest by its own timestamp rather than by position: the resource
  // happens to publish newest-first, and a card whose queue order depends on
  // that is one sort change away from starving the request it was built to
  // surface.
  const current = approvals.reduce<Approval | null>(
    (oldest, approval) => (!oldest || approval.created_at < oldest.created_at ? approval : oldest),
    null,
  );
  const currentId = current?.id ?? "";
  const hasAny = current !== null;

  /**
   * Decides whether the floating surface — the strip plus the decision card —
   * would cover reading content or a changed-file row. Runs after every commit
   * (the card's height changes with the approval it shows) and on scroll,
   * resize and content mutations.
   */
  const measureOverlap = useCallback(() => {
    // A visible panel owns the screen: there is nothing for the card to cover,
    // and the question is asked again when the panel goes away. A phone tab
    // root still measures: the card is not mounted there, but the strip itself
    // has to yield to a conversation row it would cover.
    if (!currentId || panelOpen) return;
    const viewportWidth = window.innerWidth;
    const cached = expandedBox.current;
    let box: Rect | null = null;

    // Layout, not render: the aside's box is what the reader sees, and it
    // includes the strip the card pushes up.
    const card = surfaceRef.current?.querySelector<HTMLElement>("[data-kin-approval-card]");
    if (card && surfaceRef.current) {
      const rect = surfaceRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        box = rect;
        expandedBox.current = {
          id: currentId,
          height: rect.height,
          rightGap: Math.max(0, viewportWidth - rect.right),
          width: rect.width,
        };
      }
    } else if (raised && surfaceRef.current) {
      // A phone tab root never mounts the card, so the aside is the whole
      // surface and its box is the strip's. The card is absent by design here,
      // not because a measurement removed it, so measuring directly cannot
      // flicker — and the cached strip below keeps the yield latched while the
      // aside is unmounted.
      const rect = surfaceRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        box = rect;
        expandedBox.current = {
          id: currentId,
          height: rect.height,
          rightGap: Math.max(0, viewportWidth - rect.right),
          width: rect.width,
        };
      }
    } else if (raised && stripBox.current && stripBox.current.id === currentId) {
      // The yield unmounted the aside. Rebuild the pill from its own last box,
      // anchored to the viewport rather than to the CSS fallback: the raised
      // bottom is `9.25rem + env(safe-area-inset-bottom)`, and an inset the
      // fallback cannot see would move the rebuilt pill off the row, bring it
      // back, and alternate until React throws #185.
      const width = viewportWidth >= 768 ? stripBox.current.width : Math.max(0, viewportWidth - 24);
      const right = viewportWidth - stripBox.current.rightGap;
      const bottom = window.innerHeight - stripBox.current.bottomFromViewport;
      box = {
        top: bottom - stripBox.current.height,
        bottom,
        left: right - width,
        right,
        width,
        height: stripBox.current.height,
      };
    } else if (cached && cached.id === currentId) {
      // Strip only, because of this very measurement: rebuild the expanded box
      // from the remembered height so the card does not come back just because
      // the strip is smaller. The width follows the container: 24rem beside the
      // dock from `md` up, the full inset width on a phone.
      const width = viewportWidth >= 768 ? cached.width : Math.max(0, viewportWidth - 24);
      const right = viewportWidth - cached.rightGap;
      // The same fixed offsets the class list falls back to: desktop clears
      // the dock with `md:bottom-6`, a phone clears its composer strip.
      const bottomOffset = bottom ?? (viewportWidth >= 768 ? 24 : raised ? 148 : 88);
      const bottomEdge = window.innerHeight - bottomOffset;
      box = {
        top: bottomEdge - cached.height,
        bottom: bottomEdge,
        left: right - width,
        right,
        width,
        height: cached.height,
      };
    }
    if (!box) return;

    /**
     * Whether `box` covers any laid-out element matching `selector`. A box in
     * a hidden pane (`display:none`) has no area; nothing can be covered
     * there, and counting it would keep the strip forever once a second
     * conversation had been opened.
     */
    const covers = (rect: Rect, selector: string): boolean => {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const other = el.getBoundingClientRect();
        if (other.width === 0 && other.height === 0) continue;
        if (rectsOverlap(rect, other)) return true;
      }
      return false;
    };

    // Every interactive row in the stream carries the same unscoped marker:
    // a changed-file row, a conversation row, and a question card's
    // custom-answer and submit rows all say `data-kin-hit-row=""`. The card
    // yields to it at every width — a tablet or Mac column is not a licence to
    // cover a field the reader types into, or the button that sends it.
    const hitRowSelector = "[data-kin-hit-row]";
    const hit = covers(box, hitRowSelector) || covers(box, "[data-kin-reading]");
    if (hit !== covered) setCovered(hit);

    // The strip's own pill: measured directly whenever it is mounted, and
    // rebuilt at that same offset from the bottom when it is hidden.
    const strip = surfaceRef.current?.querySelector<HTMLElement>("[role='status']") ?? null;
    let stripRect: Rect | null = null;
    if (strip) {
      const rect = strip.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        stripRect = rect;
        stripBox.current = {
          id: currentId,
          height: rect.height,
          rightGap: Math.max(0, viewportWidth - rect.right),
          width: rect.width,
          bottomGap: box.bottom - rect.bottom,
          bottomFromViewport: window.innerHeight - rect.bottom,
        };
      }
    } else if (stripBox.current && stripBox.current.id === currentId) {
      const width = viewportWidth >= 768 ? stripBox.current.width : Math.max(0, viewportWidth - 24);
      const right = viewportWidth - stripBox.current.rightGap;
      stripRect = {
        top: box.bottom - stripBox.current.bottomGap - stripBox.current.height,
        bottom: box.bottom - stripBox.current.bottomGap,
        left: right - width,
        right,
        width,
        height: stripBox.current.height,
      };
    }
    // Where the list is the screen (a phone tab root) a laid-out conversation
    // row or a project heading is the entry, so the pill yields to both. The
    // heading is a row in that same list — it carries `data-kin-hit-row` — and
    // a pill that yielded only to conversation rows stayed over it and ate the
    // tap that folds the group. A wide screen keeps its card: there the list
    // is a column beside the conversation, and a sidebar row sharing the
    // pill's x-band (reported at 360–364 at 768) is not what the pill floats
    // over — yielding there would take the surface away.
    const stripHit =
      stripRect !== null &&
      covers(
        stripRect,
        raised
          ? "[data-kin-reading], [data-session-row], [data-kin-hit-row]"
          : "[data-kin-reading]",
      );
    if (stripHit !== hidden) setHidden(stripHit);
  }, [currentId, raised, panelOpen, bottom, covered, hidden]);

  // A different approval is a different card, with its own height and its own
  // box: the one remembered for the approval before it says nothing about this
  // one. Left in place, the stale id made the strip-only branch below find
  // nothing to rebuild, `covered` stayed true, and answering the oldest of a
  // queue from the task page or the tray kept the next approval's card
  // unmounted until a reload. Cleared before the measuring effect runs, so the
  // new card mounts and is measured afresh.
  useLayoutEffect(() => {
    expandedBox.current = null;
    stripBox.current = null;
    setCovered(false);
    setHidden(false);
  }, [currentId]);

  // Layout, not passive: the card would otherwise paint one frame over the
  // row before the strip replaces it.
  useLayoutEffect(() => {
    measureOverlap();
  }, [measureOverlap, screenKey]);

  // Rows move without a React render: the transcript scrolls, the window is
  // resized, and the evidence card folds, unfolds or grows a diff preview.
  // Scroll covers the first, resize the second, and a document observer
  // filtered to evidence subtrees the third — an unfiltered body observer
  // would wake on every transcript token for no reason. The list's own rows
  // are watched too: a cold `/sessions` load, a refetch or a cleared filter
  // lands rows under the pill with no scroll and no resize, and a row the pill
  // covers without re-measuring is the filed defect.
  useEffect(() => {
    if (!hasAny) return;
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        measureOverlap();
      }, 0);
    };
    const touchesEvidence = (record: MutationRecord): boolean => {
      const target = record.target;
      if (target instanceof Element && target.closest("[data-kin-evidence]")) return true;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches(
            "[data-kin-evidence], [data-kin-hit-row], [data-kin-reading], [data-session-row]",
          )
        )
          return true;
        if (
          node.querySelector(
            "[data-kin-evidence], [data-kin-hit-row], [data-kin-reading], [data-session-row]",
          )
        ) {
          return true;
        }
      }
      return false;
    };
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (records.some(touchesEvidence)) schedule();
          });

    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    mutations?.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      mutations?.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [hasAny, measureOverlap]);

  useEffect(() => {
    const decision = keepFocus.current;
    if (!decision) return;
    keepFocus.current = null;
    // The same button the reader used, on the card that is now showing: a
    // keyboard user answering a queue keeps the key that answers it.
    const next = surfaceRef.current?.querySelector<HTMLElement>(
      // eslint-disable-next-line kin/no-legacy-class -- a DOM selector for the button already on the card, not a class assignment
      decision === "approved" ? ".kin-btn-approve" : ".kin-btn-deny",
    );
    // The card may be a strip: the next approval can arrive while a
    // changed-file row keeps the decision surface unmounted. The strip's one
    // button is then the surface, and it is where the key belongs.
    (next ?? surfaceRef.current?.querySelector<HTMLElement>("button"))?.focus({
      preventScroll: true,
    });
  }, [currentId]);

  // A decision that failed leaves the same card up and the intent to move
  // focus still armed. Without this, minutes later — an approval expiring out
  // of the queue, say — a *different* approval becoming current would pull
  // focus out of whatever the reader had moved on to.
  const busyForCurrent = current ? (busy[current.id] ?? null) : null;
  useEffect(() => {
    if (keepFocus.current && !busyForCurrent) keepFocus.current = null;
  }, [busyForCurrent, currentId]);

  // `screenKey` is the route: on a conversation the composer comes and goes
  // with it, and an effect that ran once would keep the offset of a screen the
  // reader has left. `hasAny` keeps a route with nothing to show from
  // installing an observer over the whole document.
  //
  // Layout, not passive: the measurement sets state that positions the card,
  // and a mount (a route change, or coming back to the list) would
  // otherwise paint one frame at the fallback offset, over the composer.
  useLayoutEffect(() => {
    // A panel that paints over the whole screen leaves the conversation's band
    // laid out behind it, so its box says nothing about what is visible —
    // measuring it parked the strip over the panel's own comment box. Only a
    // panel in its `lg` column leaves the conversation (and that band) on
    // screen.
    const coversScreen = () => panelOpen && !(panelColumn && window.innerWidth >= 1024);
    if (!hasAny || (!expectsBottomChrome && !coversScreen())) {
      setBottom(null);
      return;
    }
    let chrome: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutations: MutationObserver | null = null;

    // The panel's own bottom furniture — the diff comment box, the comments
    // tray — is a labelled region docked at its bottom. The highest one laid
    // out is the top of the docked stack: clearing it clears every region
    // below, where measuring the lowest would park the strip over the comment
    // box above it. With nothing docked the fixed offset below stands, and
    // nothing in the panel is covered.
    const docked = (): HTMLElement | null => {
      let highest: HTMLElement | null = null;
      let top = Infinity;
      for (const region of document.querySelectorAll<HTMLElement>(
        "[role='complementary'] section[aria-label]",
      )) {
        const rect = region.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.top < top) {
          top = rect.top;
          highest = region;
        }
      }
      return highest;
    };

    const findBand = (): HTMLElement | null =>
      // Only the pane on screen marks the page's band, so this is scoped by
      // the page rather than filtered here — a cached conversation renders the
      // same composer, `display:none`, and measuring it would be measuring
      // nothing.
      coversScreen() ? docked() : document.querySelector<HTMLElement>("[data-kin-bottom-chrome]");

    const measure = () => {
      if (!chrome) return;
      const rect = chrome.getBoundingClientRect();
      // A band that is not laid out has no box; an offset measured against
      // zero would push the card off the top of the screen. Keep watching.
      if (rect.width === 0 && rect.height === 0) {
        setBottom(null);
        return;
      }
      // Above the band, with the same 8px breath the footer gets.
      setBottom(Math.max(0, Math.round(window.innerHeight - rect.top + 8)));
    };

    const attach = () => {
      const found = findBand();
      if (!found) {
        // Nothing to clear any more (the panel turned into a covering overlay
        // on resize, or its docked regions went away). Drop the old band: it
        // may still be connected behind the panel, and observing it would keep
        // the strip parked on something the reader cannot see.
        resizeObserver?.disconnect();
        resizeObserver = null;
        chrome = null;
        return false;
      }
      if (found !== chrome) {
        resizeObserver?.disconnect();
        chrome = found;
        // ResizeObserver is absent in jsdom; the measurement above still runs
        // once there, which is all a test needs.
        resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
        resizeObserver?.observe(found);
      }
      measure();
      return true;
    };

    // The panel's furniture comes and goes with the reader's taps, and focus
    // moves with it: the comment box takes its field, saving hands focus back
    // to the diff. That signal is enough to re-read the band without watching
    // an editor tree that mutates on every keystroke.
    const rescan = () => {
      if (!attach()) setBottom(null);
    };

    document.addEventListener("focusin", rescan);
    document.addEventListener("focusout", rescan);
    window.addEventListener("resize", rescan);

    if (!attach()) {
      setBottom(null);
      // A conversation draws its composer after the task loads, so on a cold
      // load the band is not there yet. Watch for it until it arrives or the
      // reader leaves; the observer lives no longer than the route does.
      // A covering panel needs no such watch: its furniture is docked by a
      // tap, and every tap moves focus, so `rescan` is the cheaper signal
      // than a body observer that would wake on every transcript token.
      if (!coversScreen()) {
        mutations = new MutationObserver(() => {
          if (!attach()) return;
          mutations?.disconnect();
          mutations = null;
        });
        mutations.observe(document.body, { childList: true, subtree: true });
      }
    }

    return () => {
      document.removeEventListener("focusin", rescan);
      document.removeEventListener("focusout", rescan);
      window.removeEventListener("resize", rescan);
      mutations?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [screenKey, expectsBottomChrome, hasAny, panelOpen, panelColumn]);

  // The band the visible strip occupies, published where a page that scrolls
  // under it can reserve it. `/routines` draws the strip above the phone footer
  // and its pane scrolls beneath both; with no band the second routine card's
  // 立即运行 and 编辑 sat under the pill and the pane had no scroll room to
  // bring them clear (dogfood 2026-11-24-14). The numbers are the ones
  // `measureOverlap` already reads: the pill's height and its bottom edge's
  // distance from the viewport's bottom. `index.css`'s
  // `.phone-approval-clearance` takes the larger of that band + 8px and the
  // footer's clearance, and falls back to the footer alone when neither
  // variable is set.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty("--approval-strip-height");
      root.style.removeProperty("--approval-strip-bottom");
    };
    if (!currentId || (hidden && !panelOpen)) {
      // Nothing is painted — no approval, or the strip yielded to a row and
      // only its sr-only live region is left. A reserved band there would be a
      // blank gap above the footer with nothing to explain it.
      clear();
      return;
    }
    let observer: ResizeObserver | null = null;
    const publish = () => {
      const strip = surfaceRef.current?.querySelector<HTMLElement>("[role='status']");
      const rect = strip?.getBoundingClientRect();
      if (!strip || !rect || (rect.width === 0 && rect.height === 0)) {
        // Not laid out (a cold route) or kept behind a hidden pane: a zero box
        // says nothing about where the pill would sit, so publish nothing
        // rather than a band of 0.
        clear();
        return;
      }
      root.style.setProperty("--approval-strip-height", `${Math.round(rect.height)}px`);
      root.style.setProperty(
        "--approval-strip-bottom",
        `${Math.max(0, Math.round(window.innerHeight - rect.bottom))}px`,
      );
    };
    publish();
    // The queue count and the task title change the pill's height without a
    // route or approval-id change; the observer keeps the published band true.
    const strip = surfaceRef.current?.querySelector<HTMLElement>("[role='status']");
    if (strip && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(publish);
      observer.observe(strip);
    }
    return () => {
      observer?.disconnect();
      clear();
    };
  }, [currentId, hidden, panelOpen, bottom, covered, raised, screenKey]);

  if (!current) return null;

  const waiting = approvals.length - 1;
  // The strip is the whole surface in three places: a phone tab root (the card
  // covered the conversation list), any screen a visible panel owns, and a
  // conversation where the decision card would cover a changed-file row. The
  // bottom offset above stays keyed on `raised` alone — it is about the page's
  // own furniture, not about what is painted over it.
  const stripOnly = raised || panelOpen || covered;
  // The shell's task list first: it is the live row and follows a rename. The
  // title the API joined onto the approval when the list was read is the
  // fallback for a task outside that page — and approvals that arrive while
  // the app is open carry none at all, so "another task" is the honest last
  // resort rather than a name invented for a task this card cannot see.
  const title = titleFor(current.task_id) || current.task_title;
  const titleText = title || tr("approval.floatingFallback");

  const decide = (decision: Decision) => {
    keepFocus.current = surfaceRef.current?.contains(document.activeElement) ? decision : null;
    onDecide(current.id, decision);
  };

  // On the phone's tab roots the pill is the whole surface, and the task link
  // is the only hit target: the card's body covered the conversation list, so
  // a row underneath it could not be tapped — the reader's finger landed on
  // the panel instead of the conversation it named. Where the list is the
  // screen, the list's own row is the entry: a row under the pill suppresses
  // the surface instead of being covered by it, and the row carries the count
  // and the needs-you dot. 待批准 belongs to its conversation (IA §通知). The
  // strip's name spells out what the small visible parts mean, including the
  // queue behind the one it opens.
  const stripLabel = [
    tr("approval.floatingLabel"),
    titleText,
    waiting > 0 ? tr("approval.moreWaiting", { n: waiting }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Keep the arrival announcement while the visible surface yields to reading
  // content or a conversation row. Outside the aside/surfaceRef, it cannot
  // enter strip measurements; the next measurement restores the surface when
  // the content scrolls clear.
  if (hidden && !panelOpen) {
    return <ApprovalStatus className="sr-only">{stripLabel}</ApprovalStatus>;
  }

  return (
    <aside
      ref={surfaceRef}
      aria-label={tr("approval.floatingLabel")}
      style={bottom === null ? undefined : { bottom }}
      className={[
        // `fixed` because it has to survive scrolling every screen it appears
        // over, and because a floating surface is what makes the elevation
        // honest — nothing behind it moves to make room.
        "pointer-events-none fixed inset-x-3 z-40 flex flex-col gap-1.5",
        "md:inset-x-auto md:right-6 md:w-[24rem]",
        // A column panel owns the right-hand 380px; the strip stays over the
        // conversation instead of inside the panel's own bottom controls (the
        // diff comment box and the comments tray). Below `lg` even a column
        // panel is the full-bleed overlay, so this override is inert there.
        panelColumn && "lg:right-[calc(380px+1.5rem)]",
        // Where the page has no bottom furniture to measure, the list page's
        // footer and "new chat" button decide: above them when the reader is
        // on the list, and above where they would be in a pushed screen.
        bottom === null &&
          (raised
            ? "bottom-[calc(9.25rem+env(safe-area-inset-bottom))]"
            : "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]"),
        "md:bottom-6",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* A live region: an approval arriving while the reader is on another
          screen is the whole point of this surface, and a silent arrival
          means the agent stays stopped until someone happens to look. Opaque
          like the card under it: this pill floats over the list too, and the
          glass surface let the row text read through it. */}
      <ApprovalStatus
        // The card sits outside the pane that owns tab swiping, so this cannot
        // fire today; it keeps a gesture starting here from turning the page if
        // the card ever moves inside that pane.
        data-phone-swipe="true"
        className="bg-kin-panel pointer-events-auto flex items-center gap-2 self-start rounded-full py-1 pl-3 pr-2 shadow-e2"
      >
        {stripOnly ? (
          // One target, not three: the label, the task and the count are all
          // inside the button, so the whole pill answers a thumb and the name
          // says what the small parts mean. The pill's own padding and
          // `bg-kin-panel` are the strip's, so the visual is today's chip.
          <Button
            variant="quiet"
            onClick={() => onOpenTask(current.task_id)}
            aria-label={stripLabel}
            title={tr("approval.openTask")}
            className="min-h-11! min-w-0 rounded-full px-0 py-0 text-caption"
          >
            {/* Astryx wraps `children` in its own label span, so a `gap` on
                the button separates nothing between these three. One child of
                our own keeps the label, the task and the count 8px apart. */}
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-caption font-semibold uppercase tracking-label text-kin-muted">
                {tr("approval.floatingLabel")}
              </span>
              <span className="min-w-0 max-w-approval-title truncate text-caption font-medium text-kin-blue-ink!">
                {titleText}
              </span>
              {waiting > 0 && (
                <span className="shrink-0 rounded-full bg-kin-orange/15 px-1.5 py-0.5 text-caption font-semibold text-kin-orange-ink">
                  +{waiting}
                </span>
              )}
            </span>
          </Button>
        ) : (
          <>
            <span className="text-caption font-semibold uppercase tracking-label text-kin-muted">
              {tr("approval.floatingLabel")}
            </span>
            <Button
              variant="quiet"
              onClick={() => onOpenTask(current.task_id)}
              title={tr("approval.openTask")}
              // The strip's task link, not a filled action: keep its compact
              // pill and blue ink instead of the facade's row geometry.
              className="block max-w-approval-title min-h-0! truncate rounded-full px-1 py-0.5 text-caption font-medium text-kin-blue-ink! hover:bg-transparent! hover:underline"
            >
              {titleText}
            </Button>
            {waiting > 0 && (
              <>
                {/* The visible `+1` is a count with no noun; the label is what
                    a screen reader should hear, and `aria-label` on a plain
                    span is ignored — so the number is hidden from AT and the
                    sentence is rendered for it instead. */}
                <span
                  aria-hidden="true"
                  title={tr("approval.moreWaiting", { n: waiting })}
                  className="rounded-full bg-kin-orange/15 px-1.5 py-0.5 text-caption font-semibold text-kin-orange-ink"
                >
                  +{waiting}
                </span>
                <span className="sr-only">{tr("approval.moreWaiting", { n: waiting })}</span>
              </>
            )}
          </>
        )}
      </ApprovalStatus>
      {/* The decision card belongs to a conversation (and to Mac), never to a
          phone tab root or a screen with a panel open: there the strip above is
          the whole surface and the card would paint over the thing the reader
          opened. An opaque base under it: `ApprovalCard`'s own surface is a
          translucent orange tint, which is right in the transcript (a solid
          pane behind it) and unreadable here, floating over list rows whose
          text showed through. Same radius so the base never peeks out. */}
      {!stripOnly && (
        <div
          data-kin-approval-card=""
          className="pointer-events-auto max-h-[50dvh] overflow-y-auto kin-scroll rounded-xl bg-kin-panel md:max-h-[60dvh]"
        >
          {/* Keyed by the approval: a payload that cannot render costs this one
              card, and the boundary's "caught" state is thrown away when the
              queue moves on — a permanently wedged boundary would hide every
              later approval until a reload, which is the opposite of the point.
              (Error boundaries catch render throws only; the payload is
              consumed in render, which is where an agent-supplied value can
              hurt.) */}
          <ErrorBoundary key={current.id} fallback={null}>
            <ApprovalCard
              approval={current}
              busy={busy[current.id] ?? null}
              onApprove={() => decide("approved")}
              onDeny={() => decide("denied")}
              onOpenPath={onOpenPath}
              showKeys={false}
            />
          </ErrorBoundary>
        </div>
      )}
    </aside>
  );
}
