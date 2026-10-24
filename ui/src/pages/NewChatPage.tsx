import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError,
  createRoutine,
  createTask,
  findProjectByRoot,
  getRoutingOptions,
  recentCwds,
  type OnePagerSummary,
  type Project,
} from "../api/client";
import BranchPicker from "../components/chat/BranchPicker";
import CwdPicker from "../components/chat/CwdPicker";
import Composer from "../components/chat/Composer";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import AgentModelPicker from "../components/chat/AgentModelPicker";
import MachinePicker from "../components/chat/MachinePicker";
import {
  DispatchSelector,
  defaultDispatchSelection,
  isDispatchReady,
  type DispatchSelection,
} from "../components/chat/DispatchSelector";
import { IconMachine, IconRoutines } from "../components/icons";
import RoutineScheduleFields, {
  defaultNextRunLocal,
  parseLocalDateTime,
} from "../components/routine/RoutineScheduleFields";
import ProjectSummaryCard from "../components/project/ProjectSummaryCard";
import { useT } from "../i18n/react";
import { modelsForAgent } from "../lib/agentModels";
import {
  agentAvatarMeta,
  agentDisplayName,
  mentionHints,
  parseAgentDirective,
} from "../lib/agentMention";
import {
  clearDraftPrompt,
  getDraftAttachments,
  getDraftCwd,
  getDraftMachine,
  getDraftPrompt,
  setDraftAttachments,
  setDraftCwd,
  setDraftMachine,
  setDraftPrompt,
} from "../lib/draftChat";
import { useMachines } from "../hooks/useMachines";
import { catalogFor, cwdAfterMachineChange, cwdSuggestions, findMachine } from "../lib/devices";
import { projectLabel } from "../lib/paths";
import {
  getDraftPermissionMode,
  normalizePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
  setDraftPermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import { newChatControlGroups, type NewChatControlId } from "../lib/newChatWorkbench";
import { useAppStore } from "../store/appStore";

/**
 * New session: user talks to the configured main agent.
 * When cwd maps to a project, show a structured One-Pager summary.
 * Multi-@ prompts are orchestrated by the daemon (sub-agents = task workers only).
 */
export default function NewChatPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const pushToast = useAppStore((s) => s.pushToast);
  const tr = useT();

  const [cwd, setCwd] = useState(() => getDraftCwd());
  const [initialValue, setInitialValue] = useState(() => getDraftPrompt());
  const [previewPrompt, setPreviewPrompt] = useState(() => getDraftPrompt());
  const [initialAttachments] = useState(() => getDraftAttachments());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    getDraftPermissionMode(),
  );
  const [asRoutine, setAsRoutine] = useState(false);
  /** Phone only: the run/route/workspace controls live behind this. */
  const [controlsOpen, setControlsOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetOpenerRef = useRef<HTMLButtonElement>(null);

  /**
   * The phone sheet behaves like the app's other overlays: Escape closes it,
   * focus moves into it, and focus comes back to the line that opened it.
   *
   * Focus lands on the sheet itself rather than its first control — that
   * control is a <select>, and landing on one on iOS pops the wheel before
   * anyone has read what the sheet says.
   */
  useEffect(() => {
    if (!controlsOpen) return;
    const opener = sheetOpenerRef.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /*
        An open popover inside the sheet owns this Escape and closes first; the
        sheet goes on the next press. Phase cannot express that — both listen on
        `document`, and whichever runs first still closes both in the same
        keystroke — so the sheet has to look for one.
      */
      if (sheetRef.current?.querySelector('[role="dialog"], [role="listbox"]')) {
        return;
      }
      event.stopPropagation();
      setControlsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => sheetRef.current?.focus(), 20);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      opener?.focus();
    };
  }, [controlsOpen]);
  const [routineInterval, setRoutineInterval] = useState(86400);
  const [routineNextLocal, setRoutineNextLocal] = useState(() => defaultNextRunLocal());

  const [selectedModel, setSelectedModel] = useState("");
  const [selectedHost, setSelectedHost] = useState("");
  const [machineId, setMachineId] = useState<string>(() => getDraftMachine());
  const {
    machines,
    agents: localAgents,
    loading: machinesLoading,
    failed: machinesFailed,
    refresh: refreshMachines,
  } = useMachines();
  const [dispatch, setDispatch] = useState<DispatchSelection>(defaultDispatchSelection);
  const [dispatchPreviewBlocked, setDispatchPreviewBlocked] = useState(false);
  const [sending, setSending] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [projectSummary, setProjectSummary] = useState<OnePagerSummary | null>(null);
  const [projectLookupState, setProjectLookupState] = useState<
    "idle" | "loading" | "ready" | "missing" | "error"
  >("idle");
  const [projectLookupError, setProjectLookupError] = useState<string | null>(null);
  const [projectLookupKey, setProjectLookupKey] = useState(0);
  const [dirs, setDirs] = useState<string[]>([]);

  useEffect(() => {
    refreshMachines();
    recentCwds()
      .then((recent) => {
        setDirs(recent);
        setCwd((c) => {
          if (c) return c;
          const next = recent[0] || "";
          if (next) setDraftCwd(next);
          return next;
        });
      })
      .catch(() => undefined);
    getRoutingOptions()
      .then((opts) => {
        if (opts.defaults.enabled && opts.defaults.default_team) {
          setDispatch({
            mode: "auto",
            team: opts.defaults.default_team,
            objective: opts.defaults.objective || "balanced",
          });
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- machine list is re-read once per open
  }, []);

  useEffect(() => {
    const q = params.get("q");
    if (q) {
      setInitialValue(q);
      setPreviewPrompt(q);
      setDraftPrompt(q);
    }
    const cwdParam = params.get("cwd");
    if (cwdParam) {
      setCwd(cwdParam);
      setDraftCwd(cwdParam);
    }
  }, [params]);

  const machine = machineId ? findMachine(machines, machineId) : undefined;
  // A machine that was chosen and has since gone away (revoked, or the device
  // list failed) must not fall back to running here: the cwd in the box is a
  // path on that machine, and the same path may well exist on this one.
  const machineGone = Boolean(machineId) && !machinesLoading && !machine;
  const isSelf = !machine || machine.isSelf;
  const remote = !isSelf;

  // Resolve project summary for the selected cwd (read-only; never auto-create).
  // Only here: a project is a Hub-side record keyed by a path on the Hub's own
  // filesystem, so looking up another machine's path would match a local
  // project that happens to sit at the same path. A machine that has gone away
  // counts as elsewhere: its cwd is still a path over there.
  useEffect(() => {
    const path = cwd.trim();
    if (remote || machineGone) {
      setProject(null);
      setProjectSummary(null);
      setProjectLookupState("idle");
      setProjectLookupError(null);
      return;
    }
    if (!path) {
      setProject(null);
      setProjectSummary(null);
      setProjectLookupState("idle");
      setProjectLookupError(null);
      return;
    }
    let cancelled = false;
    setProjectLookupState("loading");
    setProjectLookupError(null);
    setProject(null);
    setProjectSummary(null);
    (async () => {
      try {
        const res = await findProjectByRoot(path);
        if (cancelled) return;
        const p: Project = {
          id: res.id,
          name: res.name,
          mode: res.mode,
          status: res.status,
          soft_progress: res.soft_progress,
          created_at: res.created_at,
          updated_at: res.updated_at,
          last_active_at: res.last_active_at,
          roots: res.roots,
          one_pager_path: res.one_pager_path,
        };
        setProject(p);
        setProjectSummary(res.one_pager_summary ?? null);
        setProjectLookupState("ready");
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setProject(null);
          setProjectSummary(null);
          setProjectLookupState("missing");
          setProjectLookupError(null);
          return;
        }
        setProject(null);
        setProjectSummary(null);
        setProjectLookupState("error");
        setProjectLookupError(e instanceof Error ? e.message : tr("newChat.projectSummaryError"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, remote, machineGone, projectLookupKey, tr]);

  const agents = useMemo(
    () => catalogFor(remote ? machine : undefined, localAgents),
    [remote, machine, localAgents],
  );
  const cwdDirs = useMemo(
    () => cwdSuggestions(remote ? machine : undefined, dirs),
    [remote, machine, dirs],
  );
  const machineLabel = machine && !machine.isSelf ? machine.label : "";

  const available = useMemo(() => agents.filter((a) => a.available), [agents]);
  const availableIds = useMemo(() => available.map((a) => a.id), [available]);
  const defaultAgent = available.find((a) => a.default) ?? available[0];
  // Prefer explicit host pick; else daemon default; else first available.
  const mainAgentId =
    (selectedHost && availableIds.includes(selectedHost) && selectedHost) ||
    defaultAgent?.id ||
    availableIds[0] ||
    "";
  const mainAgentMeta = available.find((a) => a.id === mainAgentId) ?? defaultAgent;
  const mainAgentName = mainAgentMeta?.name ?? agentDisplayName(mainAgentId || "agent");
  const mainAgentAvatar = agentAvatarMeta(mainAgentId || "agent");
  const hints = mentionHints(availableIds, mainAgentId);

  // Drop model selection when host agent changes to one without that model.
  useEffect(() => {
    const opts = modelsForAgent(available, mainAgentId);
    if (selectedModel && opts.length > 0 && !opts.some((m) => m.id === selectedModel)) {
      setSelectedModel("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-check when host agent id changes
  }, [mainAgentId]);

  function chooseMachine(id: string | null) {
    const chosen = id ?? "";
    // Re-picking the machine already selected must not touch the directory:
    // cwdAfterMachineChange would move a valid cwd to the first suggestion of
    // the same machine, i.e. into a different repository.
    if (chosen === machineId) return;
    const next = findMachine(machines, chosen);
    setMachineId(chosen);
    setDraftMachine(chosen);
    const after = cwdSuggestions(next, dirs);
    const moved = cwdAfterMachineChange(cwd, cwdDirs, after);
    if (moved !== cwd) {
      setCwd(moved);
      setDraftCwd(moved);
    }
    // Agent ids and models are the machine's own; keep nothing that was picked
    // for the machine being left.
    setSelectedHost("");
    setSelectedModel("");
    if (next && !next.isSelf) setAsRoutine(false);
  }

  async function onSubmit(text: string) {
    const raw = text.trim();
    if (!raw) return;
    if (!cwd.trim()) {
      pushToast(tr("newChat.chooseCwd"), "error");
      return;
    }
    if (machineGone) {
      pushToast(tr("machine.goneHint", { name: machineId }), "error");
      return;
    }
    if (remote && !machine.online) {
      pushToast(tr("machine.offlineHint", { name: machineLabel }), "error");
      return;
    }

    if (asRoutine) {
      setSending(true);
      setDraftPrompt(raw);
      try {
        const nextMs = parseLocalDateTime(routineNextLocal);
        const titleRunes = Array.from(raw);
        const title = titleRunes.length > 48 ? titleRunes.slice(0, 48).join("") + "…" : raw;
        const routine = await createRoutine({
          title,
          cwd: cwd.trim(),
          prompt: raw,
          interval_secs: routineInterval,
          agent: mainAgentId || undefined,
          permission_mode: permissionMode,
          project_id: project?.id,
          ...(nextMs != null ? { next_due_at: nextMs } : {}),
        });
        clearDraftPrompt();
        setAsRoutine(false);
        navigate(`/routines`, { replace: true, state: { createdId: routine.id } });
        pushToast(tr("routines.created"), "info");
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : tr("routines.actionFailed");
        pushToast(msg, "error");
      } finally {
        setSending(false);
      }
      return;
    }
    if (available.length === 0) {
      pushToast(
        remote ? tr("machine.noAgents", { name: machineLabel }) : tr("newChat.noAgents"),
        "error",
      );
      return;
    }

    const plan = parseAgentDirective(raw, availableIds);

    // Main agent (user-facing host): honor the configured default. Worker
    // mentions never replace this session host.
    let agent: string = mainAgentId;
    // No main at all — last resort single @ worker as the whole session.
    if (!agent && plan.agent) agent = plan.agent;
    if (!agent) {
      pushToast(tr("newChat.noAgentInstall"), "error");
      return;
    }

    // Keep full raw prompt so backend can parse multi-@ plans.
    const prompt = raw;

    // Validate dispatch selection before submitting.
    const dispatchReady = !remote && isDispatchReady(dispatch, dispatchPreviewBlocked);
    if (dispatch.mode && !dispatchReady) {
      pushToast(tr("newChat.dispatchIncomplete"), "error");
      setSending(false);
      return;
    }

    setSending(true);
    setDraftPrompt(raw);
    try {
      const task = await createTask({
        agent,
        cwd: cwd.trim(),
        prompt,
        permission_mode: permissionMode,
        project_id: remote ? undefined : project?.id,
        ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
        // Team dispatch is the Hub's own multi-agent routing and does not cross
        // machines, so a remote task is sent without it.
        ...(dispatchReady && !remote
          ? {
              dispatch: {
                mode: dispatch.mode,
                team: dispatch.team,
                objective: dispatch.objective,
                agent: dispatch.agent,
                provider: dispatch.provider,
                model: dispatch.model,
              },
            }
          : {}),
        ...(remote ? { executing_device_id: machine.id } : {}),
      });
      clearDraftPrompt();
      navigate(`/tasks/${task.id}`, { replace: true });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : tr("newChat.createFailed");
      pushToast(msg, "error");
    } finally {
      setSending(false);
    }
  }

  const showProjectColumn =
    project != null || projectLookupState === "loading" || projectLookupState === "error";
  const controlGroups = newChatControlGroups({ asRoutine, remote });

  /**
   * The phone's one-line stand-in for the three control groups.
   *
   * On a 440pt screen those groups took 321px — a third of the display — before
   * anything was typed, and every choice in them is one a person makes *once*,
   * when starting a session. The line says what the run will do; the sheet
   * behind it is where you change it.
   */
  const runSummary = [
    machine && !machine.isSelf ? machine.label : tr("nav.thisMachine"),
    tr(PERMISSION_MODE_LABEL_KEY[normalizePermissionMode(permissionMode)]),
    cwd ? cwd.split("/").filter(Boolean).pop() || cwd : tr("newChat.noWorkspace"),
  ].join(" · ");

  function renderControl(control: NewChatControlId) {
    switch (control) {
      case "machine":
        return (
          <MachinePicker
            key={control}
            machines={machines}
            value={machine && !machine.isSelf ? machine.id : null}
            missing={machineGone ? machineId : null}
            loading={machinesLoading}
            disabled={sending}
            onChange={chooseMachine}
          />
        );
      case "permission":
        return (
          <PermissionModePicker
            key={control}
            value={permissionMode}
            disabled={sending}
            compact
            onChange={(m) => {
              setPermissionMode(m);
              setDraftPermissionMode(m);
            }}
          />
        );
      case "routine":
        return (
          <button
            key={control}
            type="button"
            disabled={sending}
            onClick={() => setAsRoutine((v) => !v)}
            aria-pressed={asRoutine}
            aria-label={tr("routines.asRoutine")}
            title={`${tr("routines.asRoutine")} — ${tr("routines.asRoutineHint")}`}
            className={[
              "inline-flex items-center justify-center rounded-full border w-[26px] h-[26px] flex-none transition-colors disabled:opacity-50",
              asRoutine
                ? "border-kin-blue/50 bg-kin-blue/15 text-kin-blue"
                : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
            ].join(" ")}
          >
            <IconRoutines size={13} />
          </button>
        );
      case "hostModel":
        return (
          <AgentModelPicker
            key={`${control}:${mainAgentId}`}
            className="max-w-full flex-wrap"
            agents={available}
            agentValue={mainAgentId}
            onAgentChange={(id: string) => {
              setSelectedHost(id);
              setSelectedModel("");
            }}
            modelValue={selectedModel}
            models={modelsForAgent(available, mainAgentId)}
            disabled={sending}
            onModelChange={setSelectedModel}
          />
        );
      case "dispatch":
        return (
          <DispatchSelector
            key={control}
            value={dispatch}
            onChange={setDispatch}
            disabled={sending}
            prompt={previewPrompt}
            routine={asRoutine}
            onPreviewBlocked={setDispatchPreviewBlocked}
          />
        );
      case "cwd":
        return (
          <CwdPicker
            key={control}
            className="w-full sm:w-auto sm:max-w-[18rem]"
            cwd={cwd}
            locked={false}
            compact
            suggestions={cwdDirs}
            // The id that was chosen, not the machine record behind it, for the
            // same reason the branch control below passes it: a machine that has
            // gone away (revoked, or the list read failed) leaves `machine`
            // undefined, and the folder panel would then be answering a question
            // about that machine's path with this machine's directories. The
            // daemon's own desktop id is read as "here" by the machine
            // endpoints, so naming this machine is not a special case.
            device={machineId || undefined}
            onChange={(v) => {
              setCwd(v);
              setDraftCwd(v);
            }}
          />
        );
      case "branch":
        return (
          <BranchPicker
            key={control}
            cwd={cwd}
            // The id that was chosen, not the machine record behind it: when the
            // chosen machine has gone away, `machine` is undefined and reading
            // this machine's branches would answer a question about that path on
            // *that* machine with this one's refs — the mistake `machineGone`
            // already refuses for sending.
            device={machineId || undefined}
            compact
            className="max-w-full sm:flex-none"
          />
        );
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 kin-surface-chat">
      {/* `gap-2` rather than a leading `ml-2` on each child: on a phone the
          title below is `display:none` and the first visible child would
          otherwise start 8px indented, past the gutter every other row uses. */}
      <div className="h-11 flex-none flex items-center gap-2 px-4 sm:px-5 border-b border-[var(--kin-hairline)]">
        {/* The phone's shell header shows this same word (`nav.newChat` and
            `newChat.title` are one string), so only the rest of the row — who
            hosts the session, and where it runs — is worth the 44px there. It
            returns at `md`, where the shell header goes away. */}
        <div className="hidden text-strong font-semibold text-kin-text md:block">
          {tr("newChat.title")}
        </div>
        {defaultAgent && (
          <div className="text-body text-kin-muted">
            {tr("newChat.hostAgent", { name: defaultAgent.name })}
          </div>
        )}
        {remote ? (
          <div
            className="inline-flex items-center gap-1 text-body text-kin-secondary"
            title={tr("machine.remoteHint", { name: machineLabel })}
          >
            <IconMachine size={12} />
            {tr("machine.runsOn", { name: machineLabel })}
          </div>
        ) : null}
        {remote ? (
          <button
            type="button"
            onClick={refreshMachines}
            className="text-caption text-kin-blue hover:underline"
          >
            {tr("machine.refresh")}
          </button>
        ) : null}
      </div>

      <div
        className={[
          "flex-1 overflow-y-auto kin-scroll flex flex-col items-center px-6 py-10",
          showProjectColumn ? "justify-start" : "justify-center",
        ].join(" ")}
      >
        <div
          className={`w-8 h-8 rounded-[9px] flex items-center justify-center mb-4 text-body font-semibold ${mainAgentAvatar.className}`}
          aria-label={mainAgentAvatar.label}
        >
          {mainAgentAvatar.initials}
        </div>
        <h1 className="text-hero font-semibold tracking-tight text-center max-w-md">
          {tr("newChat.heroTitle", { name: mainAgentName })}
        </h1>
        <p className="mt-2 text-strong text-kin-secondary text-center max-w-md">
          {tr("newChat.heroSubtitleHost", { name: mainAgentName })}
        </p>

        {available.length > 1 && (
          <p className="mt-2 text-caption text-kin-muted">{tr("newChat.hostPickerHint")}</p>
        )}

        {agents.some((a) => !a.available) && !remote && (
          <div className="mt-1 flex sm:mt-3">
            <button
              type="button"
              className="min-h-[44px] px-3 text-body text-kin-blue hover:underline sm:min-h-0 sm:px-0"
              onClick={() => navigate("/agents")}
            >
              {tr("agents.manageLink")}
            </button>
          </div>
        )}
        {machinesFailed ? (
          <p className="mt-2 text-caption text-kin-muted">{tr("machine.listUnavailable")}</p>
        ) : null}

        <div className="mt-8 w-full max-w-xl space-y-3">
          {remote ? (
            <div className="rounded-xl border border-dashed border-[var(--kin-hairline)] bg-[var(--kin-fill)]/60 px-4 py-5 text-center text-strong text-kin-secondary">
              {machine && machine.roots.length > 0
                ? tr("machine.rootsHint", { name: machineLabel, path: machine.roots[0] })
                : tr("machine.noRoots", { name: machineLabel })}
            </div>
          ) : !cwd.trim() ? (
            <div className="rounded-xl border border-dashed border-[var(--kin-hairline)] bg-[var(--kin-fill)]/60 px-4 py-5 text-center text-strong text-kin-secondary">
              {tr("newChat.noCwdHint")}
            </div>
          ) : projectLookupState === "loading" ? (
            <div className="rounded-xl border border-[var(--kin-hairline)] bg-kin-panel/60 px-4 py-5 text-center text-strong text-kin-muted">
              {tr("newChat.projectSummaryLoading")}
            </div>
          ) : projectLookupState === "error" ? (
            <div className="w-full rounded-2xl border border-red-500/30 bg-kin-panel px-4 py-3 text-left">
              <p className="text-body text-red-500/90">
                {projectLookupError || tr("newChat.projectSummaryError")}
              </p>
              <button
                type="button"
                className="mt-2 text-body text-kin-accent hover:underline"
                onClick={() => setProjectLookupKey((k) => k + 1)}
              >
                {tr("common.retry")}
              </button>
            </div>
          ) : project ? (
            <ProjectSummaryCard project={project} summary={projectSummary} />
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--kin-hairline)] bg-[var(--kin-fill)]/60 px-4 py-5 text-center text-strong text-kin-secondary">
              {tr("newChat.onePagerNoProject", {
                project: projectLabel(cwd),
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5">
        <div className="max-w-[720px] mx-auto space-y-1.5">
          {hints.length > 0 && (
            // Desktop only: a line of @-mention hints is reference material, and
            // on the phone it was the widest thing on the screen.
            <div className="hidden text-caption text-kin-muted px-0.5 sm:block">
              {tr("newChat.tip", {
                hints: hints.join(" · "),
              })}
            </div>
          )}
          <Composer
            agents={agents}
            hostAgentId={mainAgentId}
            busy={sending}
            disabled={sending}
            initialValue={initialValue}
            initialAttachments={initialAttachments}
            placeholder={
              asRoutine
                ? tr("routines.promptPlaceholder")
                : tr("newChat.placeholder", { name: mainAgentName })
            }
            onAttachmentsChange={setDraftAttachments}
            onValueChange={(value) => {
              setDraftPrompt(value);
              setPreviewPrompt(value);
            }}
            onSubmit={onSubmit}
          />
          <div className="hidden sm:grid gap-1.5 px-0.5">
            {controlGroups.map((group) => (
              <div
                key={group.id}
                className="flex min-w-0 flex-col gap-1 rounded-[8px] border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/45 px-2 py-1.5 sm:flex-row sm:items-center sm:gap-2"
              >
                <div className="text-micro font-semibold uppercase tracking-[0.08em] text-kin-muted sm:w-[5.25rem] sm:flex-none">
                  {tr(group.labelKey)}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {group.controls.map(renderControl)}
                </div>
              </div>
            ))}
          </div>

          {/* Phone: the same controls, one line until asked for. */}
          <button
            type="button"
            ref={sheetOpenerRef}
            onClick={() => setControlsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={controlsOpen}
            className="sm:hidden flex w-full min-h-[44px] items-center gap-2 rounded-[13px] border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 text-strong text-kin-muted"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="10" cy="17" r="2" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-left">{runSummary}</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {asRoutine && (
            <div className="rounded-xl border border-kin-blue/25 bg-kin-blue/5 px-3 py-2.5">
              <div className="mb-2 text-caption font-medium text-kin-blue">
                {tr("routines.routineModeOn")}
              </div>
              <RoutineScheduleFields
                compact
                disabled={sending}
                intervalSecs={routineInterval}
                onIntervalChange={setRoutineInterval}
                nextRunLocal={routineNextLocal}
                onNextRunLocalChange={setRoutineNextLocal}
              />
            </div>
          )}
        </div>
      </div>

      {controlsOpen && (
        <div className="sm:hidden fixed inset-0 z-40 flex flex-col justify-end">
          {/* Scrim. `tabIndex={-1}` keeps it out of the tab order: as a focusable
              full-bleed button it used to be the first stop inside the dialog. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-0 bg-black/55"
            onClick={() => setControlsOpen(false)}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={tr("newChat.controlsTitle")}
            tabIndex={-1}
            /*
              The sheet is `fixed`, so it takes the viewport as its containing
              block and the root's `.safe-pad` never reaches it: with a plain
              `pb-4` the Done button sat 16px off the physical bottom, its lower
              half inside the home-indicator strip. `max()` keeps the 16px
              design gutter wherever there is no inset.
            */
            className="relative z-10 max-h-[80dvh] overflow-y-auto kin-scroll rounded-t-[20px] border-t border-[var(--kin-hairline-strong)] bg-kin-elevated px-4 pt-2.5 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <div className="mx-auto mb-3.5 h-[5px] w-9 rounded-full bg-[var(--kin-hairline-strong)]" />
            <div className="text-subtitle font-semibold">{tr("newChat.controlsTitle")}</div>
            <p className="mb-3 mt-0.5 text-body text-kin-muted">{tr("newChat.controlsHint")}</p>
            <div className="grid gap-2">
              {controlGroups.map((group) => (
                <div
                  key={group.id}
                  className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/45 px-3 py-2.5"
                >
                  <div className="text-micro font-semibold uppercase tracking-[0.08em] text-kin-muted">
                    {tr(group.labelKey)}
                  </div>
                  {/* The pickers are built for a mouse: 17–28px chips. Inside a
                      phone sheet every one of them has to clear 44pt, so the row
                      lifts its descendants rather than each picker carrying a
                      second set of sizes. min-height beats an explicit height,
                      so a fixed h-[26px] chip still grows.
                      Note this floor is unconditional: `data-touch-mini` opts
                      out of the app-wide `.touch-lg` rule, not out of this one. */}
                  <div className="flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-[44px] [&_button]:min-w-[44px] [&_select]:min-h-[44px] [&_select]:min-w-[44px] [&_[role=button]]:min-h-[44px]">
                    {group.controls.map(renderControl)}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setControlsOpen(false)}
              className="mt-3 min-h-[48px] w-full rounded-[12px] bg-kin-blue text-subtitle font-semibold text-white"
            >
              {tr("newChat.controlsDone")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
