import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AgentSessionImportResult, Approval } from "../../api/client";
import { useTaskList, useTaskResource } from "../../api/useLiveResources";
import { isImeKeyEvent } from "../../lib/ime";
import { DRAFT_PATH, draftSurfaceActive, getDraftCwd, subscribeDraft } from "../../lib/draftChat";
import { useMinWidth } from "../../hooks/useMinWidth";
import { importToast } from "../../lib/agentSessionImport";
import { useAgentSessionImport } from "../../hooks/useAgentSessionImport";
import { useAgentCatalog } from "../../hooks/useAgentCatalog";
import { useT } from "../../i18n/react";
import { resolveArea } from "../../lib/areaNavigation";
import CommandPalette from "../CommandPalette";
import { useAppStore } from "../../store/appStore";
import Sidebar from "./Sidebar";
import AreaNav, { areaShortcutRoot, railCompact } from "./AreaNav";
import MobileHeader, { MobileHeaderButton } from "../mobile/MobileHeader";
import SessionsHeader from "../mobile/SessionsHeader";
import { IconBack, IconSearch, IconX } from "../icons";
import TerminalPanel from "../terminal/TerminalPanel";
import { isKinDesktop } from "../../lib/desktop";
import { overlayOwnsKeyboard } from "../../lib/overlayOwnsKeyboard";
import { focusInsideConversationPane, focusSessionSearch } from "../../lib/sessionSearch";
import { isTerminalToggle, localTerminalCwd } from "../../lib/terminal";
import {
  SHELL_VIEW,
  isPanelAvailable,
  panelForView,
  resolvePanel,
  type PanelContext,
  type PanelId,
} from "../../lib/panels";
import { useMachines } from "../../hooks/useMachines";
import { remoteMachine } from "../../lib/devices";
import { placeById } from "../../lib/places";
import { focusPlaceReturn, forgetDeviceNewReturn, takePlaceReturn } from "../../lib/placeReturn";
import { taskDisplayTitle } from "../../lib/taskTitle";
import { useLocalTaskTitles } from "../../lib/taskTitles";
import { floatingApprovals } from "../../lib/floatingApprovals";
import { useApprovalDecision } from "../../hooks/useApprovalDecision";
import { useEdgeSwipeBack } from "../../hooks/useEdgeSwipeBack";
import { runGuardedNavigation } from "../../lib/leaveGuard";
import { goBackToList } from "../../lib/phoneBack";
import {
  notePhoneLocation,
  PHONE_TAB_IDS,
  draftEntryState,
  draftReturnUrl,
  phonePush,
  returnListUrl,
  routerHasParent,
} from "../../lib/phoneNavigation";
import FloatingApproval from "../cards/FloatingApproval";
import PhoneFooter from "./PhoneFooter";
import ErrorBoundary from "../ErrorBoundary";

type Props = {
  children: ReactNode;
  /** The waiting approvals themselves, so one can be answered from any screen. */
  pendingApprovals: Approval[];
  routineUnreadCount?: number;
};

function publishAgentSessionSync(result: AgentSessionImportResult): void {
  const detail = {
    ...result,
    synced_at: Date.now(),
  } satisfies AgentSessionImportResult & { synced_at: number };
  try {
    window.localStorage.setItem("kin_agent_sessions_last_sync", JSON.stringify(detail));
  } catch {
    // Session sync must remain useful when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent("kin:agent-sessions-sync", { detail }));
}

const SHELL_TITLE_TASKS = { limit: 200 } as const;

/**
 * The Mac shell's column widths, as the classes spell them.
 *
 * `Sidebar` is `w-list` (304px), `AreaNav` compacts to `w-rail-compact` (64px),
 * and `PanelSurface`'s column skin is `lg:w-[380px]`. They live here as numbers
 * only so the width floor can be arithmetic instead of a screenshot: jsdom has
 * no layout, and "the conversation never drops below 420px" is the one promise
 * of this layout that a DOM test cannot measure.
 */
export const LIST_COLUMN = 304;
export const PANEL_COLUMN = 380;
export const CONVERSATION_MIN = 420;

/**
 * What is left for the conversation, in CSS pixels.
 *
 * The rail is always spent on a Mac; the list only while it is drawn; the
 * panel only while it is a column. The test in `AppShell.dom.test.tsx` pins
 * the arrangement the shell actually renders — list hidden, panel as a column
 * — above `CONVERSATION_MIN`, and the list-drawn variant below it, which is
 * *why* the list yields.
 */
export function conversationWidth({
  window: windowWidth,
  rail,
  listShown,
  panel,
}: {
  window: number;
  rail: number;
  listShown: boolean;
  /** The panel's column width, or null while no panel is a column. */
  panel: number | null;
}): number {
  return windowWidth - rail - (listShown ? LIST_COLUMN : 0) - (panel ?? 0);
}

function taskIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/tasks\/([^/]+)\/?$/);
  return m?.[1] ?? null;
}

/**
 * The tone of the shell root, and with it the safe-area band under the content.
 *
 * `.safe-pad` spends the phone's bottom inset as `padding-bottom` on this root,
 * so the root's own background — not any child surface, which stops at the
 * content box — paints the strip below the page on a notched iPhone. A fixed
 * `--kin-page` there left a grey band under a conversation (`--kin-bg`) and
 * under a session panel (`--kin-inspector`). The tone follows the frontmost
 * surface, derived from facts the shell already has; a second stored "which
 * surface" fact could disagree with what is drawn (TASTE 15).
 *
 * The classes are literal, not a `bg-[var(--kin-${tone})]` template: Tailwind
 * cannot see a composed class name and would generate no CSS for it.
 */
const ROOT_TONE = {
  page: "bg-[var(--kin-page)]",
  bg: "bg-[var(--kin-bg)]",
  inspector: "bg-[var(--kin-inspector)]",
} as const;

type RootTone = keyof typeof ROOT_TONE;

/**
 * Desktop: sidebar + main. Phone: four sibling roots share the footer and
 * content swipes; conversations and drafts push and come back in one step.
 * New chat goes to DRAFT_PATH (no modal). See KIN-CONTINUE-002.
 */
export default function AppShell({ children, pendingApprovals, routineUnreadCount = 0 }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const tr = useT();
  const selectedTaskId = taskIdFromPath(location.pathname);
  // `/sessions` draws the draft on a Mac (the sidebar is the list) and the
  // list on a phone; the shell's draft state has to agree with what is drawn,
  // not just with `/new`.
  const wide = useMinWidth(768);
  // The rail's compact width is a 1280 decision, separate from the phone/desktop
  // one: an iPad at 1100 is wide enough for the shell but not for a labelled
  // rail beside a conversation and an open panel.
  const wide1280 = useMinWidth(1280);
  const draftActive = draftSurfaceActive(location.pathname, wide);
  const desktop = isKinDesktop();
  // On the phone there is no sidebar to say where you are, so the header has to.
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  const approvalDecision = useApprovalDecision();
  // One approval can be answered from every screen except the conversation
  // that already draws it inline. See `lib/floatingApprovals.ts`.
  const floating = floatingApprovals(pendingApprovals, {
    visibleTaskId: selectedTaskId,
    // The inbox lists every waiting approval; a card on top of it would be
    // the same queue twice.
    onInbox: pathname === "/inbox",
  });
  /**
   * The pages that are a single list or form, where the shell bar can carry the
   * page's name. A detail route is excluded on purpose: its title is the item's,
   * which the route cannot know, so the page keeps its own heading.
   */
  const listTitle = !desktop
    ? pathname === "/agents"
      ? tr("nav.agentOperations")
      : pathname === "/routines"
        ? tr("nav.routines")
        : ""
    : "";
  const mobileTitle = draftActive
    ? tr("nav.newChat")
    : location.pathname.startsWith("/sessions")
      ? tr("nav.sessions")
      : location.pathname.startsWith("/settings")
        ? tr("nav.settings")
        : listTitle || tr("app.name");
  const onSessionsTab = location.pathname === "/sessions";
  // The conversation list column belongs to Conversations and nowhere else.
  // Beside Projects, Routines or Settings it repeats that area's own navigation
  // in a second column and takes 304px from the pane a table or a form needs
  // (the agent-operations table lost its last columns to it). The rail already
  // says which area is open, so the area table is the one answer here too.
  const onConversationsArea = resolveArea(location) === "conversations";
  const onPhoneTab = PHONE_TAB_IDS.some((id) => pathname === placeById(id).path);

  /**
   * Routes whose page title lives in this bar on a phone. Each of them hides
   * its own `<h1>` below `md` so the same word cannot appear twice (it did,
   * between `sm` and `md`). Everywhere else the bar only names the app and the
   * page's heading is still on screen, so the bar is a heading on these routes
   * only — which keeps exactly one visible `<h1>` at every width.
   *
   * `/sessions` is not one of them any more: it renders `SessionsHeader`, which
   * draws the page's `<h1>` and the one search field at every phone width.
   *
   * The draft is not one of them: its page opens with the greeting as its own
   * `<h1>`, so the bar names the screen in a span.
   */
  const barIsHeading = location.pathname.startsWith("/settings") || listTitle !== "";

  /**
   * Screens that ship their own header (back button + the real title).
   *
   * The prototype gives every phone screen exactly one nav bar. These screens
   * put theirs inside the page — a session's title is not knowable from the
   * route — so the shell header would be a second bar saying nothing ("Kin")
   * and eating 48px above the one bar that matters. Back is the way out of a
   * detail screen, which is what iOS does too.
   *
   * `/tasks/:id` is the remaining page that draws its own header. The old
   * `/agent-sessions/:id` URL renders no page — it is a replace-only redirect
   * to the list — but it stays in this condition so the shell header does not
   * paint for the frame before `<Navigate>` fires.
   */
  const detailRoute = selectedTaskId !== null || location.pathname.startsWith("/agent-sessions/");

  /** Detail routes whose page renders `MobileHeader` (and its own top inset). */
  const pageOwnsTopInset = selectedTaskId !== null;

  /**
   * The routes that pin a composer to the bottom and mark it with
   * `data-kin-bottom-chrome`: a conversation and the draft. The draft is a
   * band like the conversation's (amended KIN-START-001, 2026-11-21), so Start
   * hands the same box to the same place at the same width; `draftActive`
   * covers `/new` and the Mac's `/sessions`. The deleted imported-session page
   * was the third band; the sheet over the list has none, because the list is
   * the surface.
   */
  const measuredBottomBand = selectedTaskId !== null || draftActive;

  /**
   * Leaving the new-chat screen.
   *
   * It always lands on the list. The draft is a pushed screen over the list,
   * not one of the destinations whose parent is "wherever you came from"; a
   * close that returned to a conversation would leave the list out of the
   * path entirely (KIN-CONTINUE-002, step 5).
   *
   * The list it returns to is the one that opened the draft, params and all
   * (`?search=`, `?status=`, `?scope=`). Popping the entry is the cleanest
   * form when there is a real one behind: it restores the list's exact URL
   * without pushing a second copy of it. A cold `/new` has nothing behind it,
   * so replacing with the recorded list URL is the safe landing.
   */
  function closeDraft() {
    const target = draftReturnUrl(location.state);
    if (routerHasParent(location)) navigate(-1);
    else navigate(target, { replace: true });
  }

  // One back action for every pushed phone screen: the header button and the
  // left-edge swipe land here, and both ask the page first (`lib/leaveGuard`)
  // so a screen with unsaved text can confirm or refuse. The browser's own
  // Back is handled by the same module's armed history entry; the Mac sidebar
  // and the floating approval go through the same gate, so no destination
  // bypasses the question.
  const leaveScreen = () => {
    runGuardedNavigation(() => goBackToList(navigate));
  };
  const edgeBack = useEdgeSwipeBack(!wide && !onPhoneTab, () => {
    if (draftActive) closeDraft();
    else leaveScreen();
  });
  // Only the offset is visual; the handlers stay on the fixed edge strip so
  // `touch-action: pan-y` is decided where the finger lands.
  const { offset: edgeOffset, handlers: edgeHandlers } = edgeBack;

  // The tab bar is the one way between areas. A sideways drag on a root has
  // nothing to switch to; a deliberate tap on an entry is the whole gesture.
  // Feedback stays in gesture thresholds: never put a transform on `.kin-main`,
  // where fixed panels and sheets would lose the viewport as their container.

  // The shell still needs task titles for the floating approval card. The
  // list itself owns its own feed now, including search, so this read is only
  // a name lookup — not the sidebar's data.
  const taskList = useTaskList(SHELL_TITLE_TASKS);
  const tasks = taskList.data;
  // The approval card is open while the reader can be renaming in the sidebar,
  // and a rename never reaches the feed: it has to hear the local store.
  const [localTitles] = useLocalTaskTitles();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Zen: chrome out of the way, session untouched. State, not a preference —
  // nothing writes it anywhere, so a reload is always back to the shell (P3 plan
  // §2.3). What it hides is decided in `index.css` by the `kin-zen-hide` marker.
  const [zen, setZen] = useState(false);
  const { catalog: agentCatalog, refresh: refreshAgentCatalog } = useAgentCatalog();
  const [draftCwdLocal, setDraftCwdLocal] = useState<string>("");
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  // Read here rather than beside the task panel below, because the session sync
  // needs the machine list too: importing a session means asking the machine
  // that holds it, and the list of machines is what says which those are.
  const { machines } = useMachines();
  // The fan-out itself lives in the hook, because the settings section offers
  // the same errand under the same label and must ask the same machines. The
  // hook also owns the busy flag, so the sidebar's control and the settings
  // page's disable each other: two fan-outs a second apart would report counts
  // that are each other's duplicates.
  const { importing: importingExternalSessions, importEveryMachine } = useAgentSessionImport();

  const importExternalSessions = useCallback(
    async (agents?: string[]) => {
      if (importingExternalSessions) return;
      try {
        const result = await importEveryMachine(agents);
        // The list reads imported sessions on its own now; without this the
        // fold stays at the count it had when the page opened. The sync event
        // is not one this shell listens to, unlike `changed`, so the catalog
        // reload below stays the only one this errand causes.
        publishAgentSessionSync(result);
        await refreshAgentCatalog();
        const toast = importToast(result, tr);
        pushToast(toast.message, toast.kind);
      } catch (e) {
        // Unreachable today — the hook answers every failure with a result,
        // including a machine that never replied. It stays because the button
        // is the only thing a person can press: if a later change to the hook
        // makes it throw, the alternative is a control that looks like it did
        // nothing at all.
        pushToast(tr("settings.localAgents.importFailed"), "error");
      }
    },
    [importingExternalSessions, importEveryMachine, refreshAgentCatalog, pushToast, tr],
  );

  const openNewChat = useCallback(
    (approved = false) => {
      // Every caller (the palette's "New chat" row, ⌘N, the list's empty state)
      // asks the current page before leaving it, the same as Back does. The
      // palette asks itself and passes `approved`, so one departure is one
      // question. Only a literal `true` counts: a click event that arrives in
      // this slot must not read as "already asked".
      runGuardedNavigation(() => {
        const state = draftEntryState(returnListUrl(location));
        // A phone's draft has the list for a parent even when it was opened
        // from a project or a destination; otherwise closing it would put the
        // reader back on the screen they just left instead of the list. The
        // phone contract also knows when the list is already underneath, so a
        // warm trip does not stack a second copy of it. The Mac keeps ordinary
        // history: its sidebar is always on screen, and `phonePush` leaves a
        // wide layout alone.
        phonePush(navigate, location, DRAFT_PATH, { state });
      }, approved === true);
    },
    [location, navigate],
  );

  // Restore only once at the commit on which the entry is present. A render
  // may be repeated or abandoned; a layout effect cannot consume a mark twice
  // or let a frame from an old page consume the next navigation's mark.
  const returnedPlace = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (wide || pathname !== "/sessions") {
      returnedPlace.current = null;
      return;
    }
    if (returnedPlace.current) return;
    const id = takePlaceReturn();
    // This arrival belongs to a footer destination, not to the machine action
    // that opened a draft earlier; a stale device mark would steal the focus.
    if (id) forgetDeviceNewReturn();
    if (id && focusPlaceReturn(id)) returnedPlace.current = id;
  }, [location, wide, pathname]);

  // The list is the phone's home; remember the exact view (search, filters)
  // whenever it is on screen so a later push can return to it. The same
  // subscription removes a list record from a depth the route has since
  // replaced with another screen, so a stale depth cannot claim a parent.
  useEffect(() => {
    notePhoneLocation(location);
    // Focus belongs to the committed-route layout effect, which takes the mark
    // exactly once and leaves no frame to take a later destination's mark.
  }, [location, wide, pathname]);

  // The terminal is the shell's panel, and the shell's panel is the one keyed to
  // no session: there is one instance, and its directory follows the route. It
  // goes through the same store as the session panels, so `Ctrl+\`` over an open
  // workspace panel replaces it instead of painting on top of it.
  const shownPanel = useAppStore((s) => s.shownPanel);
  const togglePanel = useAppStore((s) => s.togglePanel);
  // The terminal belongs to no session, so its view key is the shell's. It is
  // still rendered unconditionally on desktop and told whether to be open, even
  // though a closed panel is invisible: `TerminalPanel` mounts its PTY on first
  // open and keeps it, and unmounting on close would kill the shell.
  //
  // Memoised on `desktop` alone: a fresh object here would rebuild the command
  // palette's row list on every render (the shell re-renders on each WS tick).
  const shellCtx: PanelContext = useMemo(
    () => ({ taskId: null, remote: false, desktop }),
    [desktop],
  );
  // Asked of the table rather than of `desktop` directly, so "where is there a
  // terminal" has one answer and the shortcut, the panel and the palette cannot
  // disagree about it.
  const terminalAvailable = isPanelAvailable("terminal", shellCtx);
  const terminalPanel = resolvePanel(panelForView(shownPanel, SHELL_VIEW), shellCtx);
  // The shell's way to open any of its panels, by id. The palette asks for one by
  // the id its table names rather than for a specific panel, so a panel added to
  // the table needs no second entry point here.
  const toggleShellPanel = useCallback(
    (id: PanelId) => {
      togglePanel(SHELL_VIEW, id);
    },
    [togglePanel],
  );
  const toggleTerminal = useCallback(() => {
    toggleShellPanel("terminal");
  }, [toggleShellPanel]);

  // Subscribe to draft cwd changes
  useEffect(() => {
    // Get initial cwd
    setDraftCwdLocal(getDraftCwd());
    // Subscribe to changes
    return subscribeDraft(() => {
      setDraftCwdLocal(getDraftCwd());
    });
  }, []);

  // ⌘N new chat · ⌘K command palette · Ctrl+Backquote toggle terminal · ⌘. zen
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A held key is one press: `isTerminalToggle` already refuses repeats, and
      // without this the two chords that toggle a surface (⌘K, ⌘.) strobe.
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNewChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // Not while the palette is up: it is a modal surface with its own key
      // handling, and hiding the chrome behind it is a change nobody asked for.
      if ((e.metaKey || e.ctrlKey) && e.key === "." && !paletteOpen) {
        e.preventDefault();
        setZen((v) => !v);
      }
      if (terminalAvailable && isTerminalToggle(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
      }
      // ⌘1–⌘3 are the three areas. Same guards as ⌘F: a held key, an IME
      // composition, a chord with another modifier, a floating layer, the
      // palette, or a page that already answered the key is not this shortcut.
      // The departure runs through the leave guard like every other one.
      // `areaShortcutRoot` is asked first: the overlay walk below is a document
      // query, and it must not run for every keystroke in a text field.
      const root = areaShortcutRoot(e);
      if (
        root &&
        !paletteOpen &&
        !e.defaultPrevented &&
        !isImeKeyEvent(e) &&
        !overlayOwnsKeyboard()
      ) {
        e.preventDefault();
        runGuardedNavigation(() => navigate(root));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [terminalAvailable, openNewChat, toggleTerminal, paletteOpen, navigate]);

  // ⌘F is the list's search (step 2). The transcript's own find bar keeps the
  // key while the caret is inside the conversation, where it is the closer
  // handler; everywhere else the one search box wins. Capture, because
  // ChatStream's window listener is registered first and would otherwise open
  // the find bar over the list the reader was looking at.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat || isImeKeyEvent(e) || e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      // Ask the focused element which pane it is in, not the document which
      // pane exists: several cached panes are mounted at once.
      if (focusInsideConversationPane()) return;
      if (overlayOwnsKeyboard()) return;
      if (focusSessionSearch()) e.preventDefault();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Which machine the open task runs on. Read from the task resource the page
  // itself uses, not from the sidebar list: that list is capped and filtered by
  // search, and a task missing from it would silently drop the guard below.
  const openTaskDetail = useTaskResource(selectedTaskId ?? "", Boolean(selectedTaskId));
  const openTask = selectedTaskId ? openTaskDetail.data.task : undefined;
  // The terminal is a shell on *this* machine. A task running on another machine
  // has a cwd that means something only over there, so it must not become this
  // shell's starting directory; the panel says why instead.
  const remoteTask = remoteMachine(machines, openTask?.executing_device_id);
  const terminalCwd = localTerminalCwd(
    openTask,
    Boolean(remoteTask),
    draftActive ? draftCwdLocal : "",
  );
  const terminalNotice = remoteTask
    ? tr(remoteTask.known ? "terminal.runsOn" : "terminal.runsOnUnknown", {
        name: remoteTask.text,
      })
    : null;

  /**
   * The session panel `TaskDetailPage` will actually draw, resolved with the
   * same facts the page builds its context from.
   *
   * Availability is the part that must not be skipped: `shownPanel` can name a
   * panel this session does not offer (publish on a local session, a task
   * whose machine just went away), and the page then renders no panel at all.
   * A shell that only asked "is a panel named?" would hide the list for a
   * surface that never appears — no panel and no `Show list` button to bring
   * the list back.
   */
  const openTaskPanel =
    selectedTaskId !== null
      ? resolvePanel(panelForView(shownPanel, selectedTaskId), {
          taskId: selectedTaskId,
          remote: remoteTask !== null,
          desktop,
        })
      : null;
  // Whether a panel is covering the conversation right now. The rail compacts
  // on it: at 1100 or with the panel open, labels cost the conversation width
  // the review loop needs (TASTE 17). The shell's panel counts too — the
  // terminal opens over a conversation while `shownPanel` names the shell's
  // view, not the conversation's, and the rail must compact underneath it.
  const panelOpen = terminalPanel !== null || openTaskPanel !== null;
  // The root paints the safe-area band below the content, so it takes the
  // colour of whatever is in front: an open panel or the shell terminal is
  // `--kin-inspector`, a conversation or the draft is `--kin-bg`, and every
  // list/form page stays `--kin-page`. Derived, not stored.
  const rootTone: RootTone = panelOpen
    ? "inspector"
    : selectedTaskId !== null || draftActive
      ? "bg"
      : "page";
  /**
   * One surface at a time: while a panel is open for the conversation in
   * front, the list column yields to it, at every width the shell is wide.
   *
   * `panelForView` is what keeps this honest in both directions. A panel
   * opened in another conversation is not this one's to hide the list for,
   * and the terminal's view is the shell's, so it leaves the list alone.
   * `resolvePanel` keeps the other direction honest: a panel that is named but
   * not offered here is not drawn by the page either, so it must not hide the
   * list. Derived rather than stored: "the list is hidden" is not a second
   * fact about the panel, and a store field could disagree with it.
   */
  const listYielded = openTaskPanel !== null;

  // Tray "New Chat" deep-link: /?new=1 or /new
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("new") === "1") {
      params.delete("new");
      const qs = params.toString();
      navigate({ pathname: DRAFT_PATH, search: qs ? `?${qs}` : "" }, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  return (
    /*
      `touch-lg` belongs on this root, not on <main>: the edge-back strip (a
      fixed sibling of <main>) and the command palette below it sit outside
      <main>, and both are phone surfaces. See index.css.

      The root also paints the safe-area band that `.safe-pad` reserves at the
      bottom, so its tone follows the frontmost surface (see `ROOT_TONE`);
      removing that padding would put the page under the home indicator.
    */
    <div
      className={`touch-lg h-[100dvh] flex ${ROOT_TONE[rootTone]} text-kin-text overflow-hidden safe-pad md:pt-safe ${
        zen ? "kin-zen" : ""
      }`}
    >
      {wide && (
        <>
          <AreaNav
            compact={railCompact(panelOpen, wide1280)}
            pendingCount={pendingApprovals.length}
            routineUnreadCount={routineUnreadCount}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          {onConversationsArea && !listYielded && (
            <Sidebar
              selectedTaskId={selectedTaskId}
              draftActive={draftActive}
              pendingCount={pendingApprovals.length}
              onNewChat={openNewChat}
              agentCatalog={agentCatalog}
              importingExternalSessions={importingExternalSessions}
              onImportExternalSessions={(agents) => void importExternalSessions(agents)}
            />
          )}
        </>
      )}

      {/*
        The phone's edge. It is a strip rather than a listener on the shell
        root because a horizontal drag needs `touch-action: pan-y` from the
        very first touch: touch-action is decided when the finger lands, so a
        root-level listener could not stop the browser from interpreting the
        pull as a pan. `pan-y` leaves vertical scrolling alone. It is absent on
        the list page, which is the root and has nowhere to go back to.
      */}
      {!wide && !onPhoneTab && (
        <div
          aria-hidden="true"
          data-kin-edge-back
          className="fixed inset-y-0 left-0 z-30 w-5 md:hidden"
          style={{ touchAction: "pan-y" }}
          {...edgeHandlers}
        />
      )}

      <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
        {/*
          Height is a *minimum*, not a fixed `h-12`. With `h-12` the box is 48px
          tall including its padding, so on a notched iPhone — where the safe
          area alone is 59px — the content box collapsed to nothing and the
          title rendered half inside the sensor housing.
        */}
        {detailRoute && !pageOwnsTopInset ? (
          /*
            No bar, but still the top inset. The page below draws its own
            header, and exactly one element must own the notch: handing that
            job to the page would mean every future detail screen has to
            remember `pt-safe`, and getting it wrong puts a title under the
            sensor housing. The session screen is the exception: it now draws a
            `MobileHeader`, which applies the inset itself — reserving it here
            too would spend the notch twice.
          */
          <div className="md:hidden flex-none pt-safe kin-zen-hide" />
        ) : detailRoute ? null : onSessionsTab ? (
          /*
            The list page owns its header: title and the one search field.
            There is no menu here to open and no settings button — settings is
            one of the four footer destinations (KIN-CONTINUE-002).
          */
          <SessionsHeader />
        ) : (
          <MobileHeader
            heading={barIsHeading}
            title={mobileTitle}
            leading={
              draftActive ? (
                /* The draft is a focused flow; its way out is a close, not a
                   trip through another navigation surface. */
                <MobileHeaderButton label={tr("app.close")} onClick={closeDraft}>
                  <IconX size={20} strokeWidth={2.1} />
                </MobileHeaderButton>
              ) : !onPhoneTab ? (
                <MobileHeaderButton label={tr("app.back")} onClick={leaveScreen}>
                  <IconBack size={20} />
                </MobileHeaderButton>
              ) : null
            }
            trailing={
              /* The command palette is the only extra control here. The
                 new-chat button lives on the list page's own bottom-right
                 corner; a second "+" in this bar would be the same action
                 twice in one viewport. */
              <MobileHeaderButton
                label={tr("app.commandPalette")}
                onClick={() => setPaletteOpen(true)}
                tone="muted"
              >
                <IconSearch size={18} />
              </MobileHeaderButton>
            }
          />
        )}

        {/*
          Below the bar, not above it. As the topmost element this pushed the
          one bar that owns `pt-safe` down the screen, so the inset was spent on
          a gap under the banner instead of on the notch, and the bar itself
          still rendered under the sensor housing.
        */}
        {wsStatus === "disconnected" && (
          <div
            className={[
              "flex-none bg-kin-orange/10 border-b border-kin-orange/25 text-kin-orange-ink text-body text-center px-3 pb-1.5",
              // On the session screen the page draws its own `MobileHeader`
              // *below* this banner, so nothing above the banner owns the
              // notch. Without this the reconnect strip rendered under the
              // sensor housing and then the header spent the inset a second
              // time beneath it.
              // `max-md:` because from `md` up the shell root spends the
              // inset once for both columns (`md:pt-safe` above); this strip
              // is below that edge, so it must not spend it again.
              pageOwnsTopInset ? "max-md:pt-safe" : "pt-1.5",
            ].join(" ")}
            role="status"
          >
            {tr("app.reconnecting")}
          </div>
        )}

        <main
          className="kin-main flex-1 min-h-0 overflow-hidden flex flex-col"
          data-phone-tab={onPhoneTab ? pathname : undefined}
          // A sideways drag on a root now belongs to the page (and to whatever
          // wide card or chart sits under the finger). The browser keeps its
          // vertical pan and pinch-zoom, but horizontal overscroll stays out.
          //
          // The edge-back offset is a custom property, not an inline transform:
          // `index.css` moves `.kin-main > *`, so every page root stays a
          // direct child of <main> and `.kin-main` itself never becomes the
          // containing block for a fixed panel. The property and the attribute
          // exist only while a phone drag is active — `useEdgeSwipeBack` zeroes
          // them on release, cancel, disable and unmount.
          style={
            {
              ...(!wide && onPhoneTab ? { touchAction: "pan-y pinch-zoom" } : null),
              ...(edgeOffset > 0 ? { "--page-swipe-x": `${edgeOffset}px` } : null),
            } as CSSProperties
          }
          data-kin-swiping={edgeOffset > 0 ? "true" : undefined}
        >
          {children}
        </main>

        {!wide && onPhoneTab && <PhoneFooter />}

        {/* An approval blocks the agent that asked for it wherever the reader
            happens to be. On the list page the footer and its new-chat button
            decide the offset; a pushed conversation measures its composer
            instead. See `FloatingApproval` for which one it shows.

            Inside a boundary of its own: the card renders an agent-supplied
            payload, and a throw in it must cost one card rather than the
            shell around every screen. */}
        <ErrorBoundary fallback={null} resetKey={floating.map((approval) => approval.id).join(",")}>
          <FloatingApproval
            approvals={floating}
            titleFor={(taskId) =>
              taskDisplayTitle(
                tasks.find((task) => task.id === taskId),
                localTitles,
              )
            }
            busy={approvalDecision.busy}
            onDecide={(id, decision) => void approvalDecision.decide(id, decision)}
            onOpenTask={(taskId) =>
              runGuardedNavigation(() =>
                phonePush(navigate, location, `/tasks/${encodeURIComponent(taskId)}`),
              )
            }
            raised={!wide && onPhoneTab}
            screenKey={pathname}
            expectsBottomChrome={measuredBottomBand}
          />
        </ErrorBoundary>

        {/* Terminal panel — the shell's own panel, desktop only */}
        {terminalAvailable && (
          <TerminalPanel
            open={terminalPanel === "terminal"}
            cwd={terminalCwd}
            notice={terminalNotice}
            onClose={() => togglePanel(SHELL_VIEW, "terminal")}
          />
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={openNewChat}
        onTogglePanel={toggleShellPanel}
        panelCtx={shellCtx}
      />
    </div>
  );
}
