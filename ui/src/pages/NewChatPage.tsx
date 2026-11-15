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
  type TaskEvent,
} from "../api/client";
import BranchPicker from "../components/chat/BranchPicker";
import ChatStream from "../components/chat/ChatStream";
import Composer from "../components/chat/Composer";
import RunConfigControl, { RunConfigSheetRow } from "../components/chat/RunConfigSheet";
import {
  DispatchSelector,
  defaultDispatchSelection,
  dispatchBlocksSend,
  isDispatchReady,
  type DispatchSelection,
} from "../components/chat/DispatchSelector";
import { IconMachine, IconRoutines } from "../components/icons";
import RoutineScheduleFields, {
  defaultNextRunLocal,
  parseLocalDateTime,
} from "../components/routine/RoutineScheduleFields";
import { serializeRoutineRule, type RoutineRule } from "../lib/routineRecurrence";
import {
  handOffPendingSend,
  pendingSend as newPendingSend,
  type PendingSend,
} from "../lib/pendingSend";
import ProjectSummaryCard from "../components/project/ProjectSummaryCard";
import PlacePicker, { type Place } from "../components/newchat/PlacePicker";
import { liveResources } from "../api/liveResources";
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
  getDraftHost,
  getDraftMachine,
  getDraftModel,
  getDraftPrompt,
  setDraftAttachments,
  setDraftCwd,
  setDraftHost,
  setDraftMachine,
  setDraftModel,
  setDraftPrompt,
} from "../lib/draftChat";
import { forgetPlaceReturn } from "../lib/placeReturn";
import { THIS_MACHINE, writeRoutineDevice } from "../lib/routineDevice";
import { useMachines } from "../hooks/useMachines";
import { useMinWidth } from "../hooks/useMinWidth";
import { catalogFor, cwdOnMachine, findMachine } from "../lib/devices";
import { projectLabel } from "../lib/paths";
import { rememberedProject, rememberProject } from "../lib/placeMemory";
import {
  getDraftPermissionMode,
  permissionModesForAgent,
  setDraftPermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import type { NewChatControlId } from "../lib/newChatWorkbench";
import { appliedRole, selectRole } from "../lib/agentRoles";
import { useAgentRoles } from "../hooks/useAgentRoles";
import SheetSelect from "../components/ui/SheetSelect";
import { useAppStore } from "../store/appStore";

/** One empty transcript, shared: the pending send has no events yet. */
const NO_EVENTS: TaskEvent[] = [];

/**
 * New session: user talks to the configured main agent.
 * When cwd maps to a project, show a structured One-Pager summary.
 * Multi-@ prompts are orchestrated by the daemon (sub-agents = task workers only).
 */
export default function NewChatPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  // The draft opens with the caret in the prompt on a Mac, and with no keyboard
  // on a phone: typing is the first act on one, and a keyboard sliding over the
  // screen before a word is written is the wrong first act on the other.
  const wide = useMinWidth(768);
  const tr = useT();

  const [cwd, setCwd] = useState(() => getDraftCwd() || rememberedProject(getDraftMachine()));
  const [draftValue, setDraftValue] = useState(() => getDraftPrompt());
  const liveDraftRef = useRef(draftValue);
  liveDraftRef.current = draftValue;
  const [previewPrompt, setPreviewPrompt] = useState(() => getDraftPrompt());
  const [initialAttachments] = useState(() => getDraftAttachments());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    getDraftPermissionMode(),
  );
  const [asRoutine, setAsRoutine] = useState(false);
  // Saved prompt prefixes. They are a settings key, so they arrive after the
  // first paint; until then the role row simply does not exist. The composer
  // gets the unknown `null` through, so its `/` menu can tell "not loaded yet"
  // apart from "none saved".
  const agentRoles = useAgentRoles();
  const roleList = agentRoles ?? [];

  const [routineInterval, setRoutineInterval] = useState(86400);
  const [routineRule, setRoutineRule] = useState<RoutineRule | null>(null);
  const [routineNextLocal, setRoutineNextLocal] = useState(() => defaultNextRunLocal());

  const [selectedModel, setSelectedModel] = useState(() => getDraftModel());
  const [selectedHost, setSelectedHost] = useState(() => getDraftHost());
  const [machineId, setMachineId] = useState<string>(() => getDraftMachine());
  const [placeNotice, setPlaceNotice] = useState<string | null>(null);
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
  /**
   * The message this page has sent but has no task id for yet. While it is set,
   * draw the same transcript the conversation route will draw so the send is
   * visible immediately. A refused create restores the draft beneath it.
   *
   * It is a `PendingSend`, not a string, because the conversation route takes
   * it over unchanged: the bubble the draft drew is the bubble the new
   * conversation settles when the daemon's own copy arrives.
   */
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [projectSummary, setProjectSummary] = useState<OnePagerSummary | null>(null);
  const [projectLookupState, setProjectLookupState] = useState<
    "idle" | "loading" | "ready" | "missing" | "error"
  >("idle");
  const [projectLookupError, setProjectLookupError] = useState<string | null>(null);
  const [projectLookupKey, setProjectLookupKey] = useState(0);
  const [dirs, setDirs] = useState<string[]>([]);
  const queryHandled = useRef(false);

  useEffect(() => {
    refreshMachines();
    recentCwds()
      .then((recent) => setDirs(recent))
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
    if (!q) {
      queryHandled.current = false;
    } else if (!queryHandled.current) {
      queryHandled.current = true;
      const existing = liveDraftRef.current;
      // A prefill from Agent Ops is an invitation. Keep words the reader
      // already wrote unless they explicitly agree to replace them.
      const replace =
        existing.trim() === "" ||
        existing === q ||
        (typeof window.confirm === "function" &&
          window.confirm(tr("newChat.replaceDraftWithPrompt")));
      if (replace) {
        setDraftValue(q);
        setPreviewPrompt(q);
        setDraftPrompt(q);
      }
      // Remove the one-time instruction so reloads and later edits are stable.
      const next = new URLSearchParams(params);
      next.delete("q");
      setParams(next, { replace: true });
    }
    const cwdParam = params.get("cwd");
    if (cwdParam) {
      setCwd(cwdParam);
      setDraftCwd(cwdParam);
    }
  }, [params, setParams, tr]);

  const machine = machineId ? findMachine(machines, machineId) : undefined;
  // A machine that was chosen and has since gone away (revoked) must not fall
  // back to running here: the cwd in the box is a path on that machine, and
  // the same path may well exist on this one. A list that failed to load is
  // not evidence of either — it is a third state, and Start says so.
  const machineUnread = Boolean(machineId) && !machinesLoading && machinesFailed && !machine;
  const machineGone = Boolean(machineId) && !machinesLoading && !machinesFailed && !machine;
  const isSelf = !machine || machine.isSelf;
  const remote = !isSelf;

  // The machine a draft was aimed at can go away (revoked, or the device list
  // was re-read and no longer lists it). Its path is a path over there, so
  // continuing on this machine with it would send a turn nobody asked for —
  // but keeping the missing id would leave the page talking to a machine that
  // cannot answer. Go back to this machine, keep the prompt, and say so. A
  // list that failed to load is not evidence the machine is gone.
  useEffect(() => {
    if (!machineId || machinesLoading || machinesFailed) return;
    if (findMachine(machines, machineId)) return;
    setMachineId("");
    setDraftMachine("");
    // Home is the project this machine was last used in, else the newest
    // recent directory. Both are this machine's own paths.
    const home = rememberedProject("") || dirs[0] || "";
    setCwd(home);
    setDraftCwd(home);
    // The agent and model were the vanished machine's own; keeping them would
    // send a model that only exists over there to whatever runs here.
    setSelectedHost("");
    setSelectedModel("");
    setPlaceNotice(tr("newChat.placeGone"));
  }, [machineId, machines, machinesLoading, machinesFailed, dirs, tr]);

  // Resolve project summary for the selected cwd (read-only; never auto-create).
  // Only here: a project is a Hub-side record keyed by a path on the Hub's own
  // filesystem, so looking up another machine's path would match a local
  // project that happens to sit at the same path. A machine that has gone away
  // counts as elsewhere: its cwd is still a path over there.
  useEffect(() => {
    const path = cwd.trim();
    if (remote || machineGone || machineUnread) {
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
  }, [cwd, remote, machineGone, machineUnread, projectLookupKey, tr]);

  const agents = useMemo(
    () => catalogFor(remote ? machine : undefined, localAgents),
    [remote, machine, localAgents],
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
  const allowedPermissionModes = permissionModesForAgent(mainAgentMeta, !remote);
  // A fresh array every render: compare what it says, not its identity.
  const allowedPermissionKey = allowedPermissionModes.join(",");

  // A mode the chosen run cannot use is not a preference to keep: a node that
  // was not started with --allow-yolo refuses the whole turn, so carrying the
  // last mode over from another machine is how the first session fails before
  // it starts. Clamp to what this machine advertises.
  useEffect(() => {
    // A machine whose list failed is not evidence of what it offers: keep the
    // chosen mode until the list is back and the real ladder can judge it.
    if (machineUnread) return;
    if (!allowedPermissionModes.includes(permissionMode)) {
      setPermissionMode("default");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the run's capability matters
  }, [allowedPermissionKey, permissionMode, machineUnread]);

  // The draft keeps the run face too: coming back to the page must not start
  // the next run on the default model after the last one was chosen.
  useEffect(() => {
    setDraftModel(selectedModel);
  }, [selectedModel]);
  useEffect(() => {
    setDraftHost(selectedHost);
  }, [selectedHost]);

  // Drop model selection when host agent changes to one without that model.
  useEffect(() => {
    if (machineUnread) return;
    const opts = modelsForAgent(available, mainAgentId);
    if (selectedModel && opts.length > 0 && !opts.some((m) => m.id === selectedModel)) {
      setSelectedModel("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check when the host agent or the machine's known-ness changes
  }, [mainAgentId, machineUnread]);

  // A draft with no directory yet starts in the most recent one on this
  // machine. Only here: a path from another machine would be sent as a local
  // path, and that machine's own projects come from its roots instead.
  useEffect(() => {
    if (cwd || remote) return;
    const next = dirs[0] || "";
    if (!next) return;
    setCwd(next);
    setDraftCwd(next);
  }, [cwd, dirs, remote]);

  // A directory that belongs to another machine — or to this one before a
  // reload — is not a directory the chosen node will run in. Move it to the
  // project that machine was last used in, and only then to its first root:
  // the remembered project is the one the reader chose for it, not a guess.
  //
  // Once per machine, never per edit: while a path is being typed it passes
  // through states the machine would refuse, and reconciling those would fight
  // the keyboard and make the field impossible to clear.
  const reconciledMachine = useRef("");
  useEffect(() => {
    if (!remote || !machine) {
      // Re-arm: coming back to this machine must check the directory again.
      reconciledMachine.current = "";
      return;
    }
    if (reconciledMachine.current === machine.id) return;
    reconciledMachine.current = machine.id;
    const next = cwdOnMachine(cwd, machine);
    if (next === cwd) return;
    const remembered = rememberedProject(machine.id);
    if (remembered && cwdOnMachine(remembered, machine) !== remembered) {
      // The project this machine was last used in is gone from what it now
      // reports. Its draft path is a place that no longer exists; going back
      // to this machine and saying so beats silently running in its first
      // root, which is a different project nobody chose.
      setMachineId("");
      setDraftMachine("");
      const home = rememberedProject("") || dirs[0] || "";
      setCwd(home);
      setDraftCwd(home);
      // Same as the vanished-machine effect: the agent and model belonged to
      // the machine being left, and the reader is now on this one.
      setSelectedHost("");
      setSelectedModel("");
      setPlaceNotice(tr("newChat.placeGoneProject"));
      reconciledMachine.current = "";
      return;
    }
    const replacement =
      remembered && cwdOnMachine(remembered, machine) === remembered ? remembered : next;
    setCwd(replacement);
    setDraftCwd(replacement);
    rememberProject(machine.id, replacement);
  }, [cwd, machine, remote, dirs, tr]);

  /** One machine and one project, chosen together. */
  function choosePlace(place: Place) {
    const machineChanged = place.machineId !== machineId;
    setMachineId(place.machineId);
    setDraftMachine(place.machineId);
    setCwd(place.cwd);
    setDraftCwd(place.cwd);
    rememberProject(place.machineId, place.cwd);
    setPlaceNotice(null);
    // Agent ids and models are the machine's own; keep nothing that was picked
    // for the machine being left.
    if (machineChanged) {
      setSelectedHost("");
      setSelectedModel("");
    }
  }

  async function onSubmit(text: string) {
    const raw = text.trim();
    if (!raw) return;
    // The composer has already cleared itself by the time this runs. Store the
    // prompt before the first guard so every refusal below — a disabled Start
    // reached by the keyboard, a failed create — leaves it in the draft, and
    // so a rejection can hand the text back to the composer.
    setDraftPrompt(raw);
    if (!cwd.trim()) {
      throw new Error(tr("newChat.chooseCwd"));
    }
    if (machineGone) {
      throw new Error(tr("machine.goneHint", { name: machineId }));
    }
    if (machineUnread) {
      throw new Error(tr("machine.listUnavailable"));
    }
    if (remote && !machine.online) {
      throw new Error(tr("machine.offlineHint", { name: machineLabel }));
    }

    if (asRoutine) {
      setSending(true);
      try {
        const nextMs = parseLocalDateTime(routineNextLocal);
        const titleRunes = Array.from(raw);
        const title = titleRunes.length > 48 ? titleRunes.slice(0, 48).join("") + "…" : raw;
        // A wall-clock rule carries its own pace and first run, so an interval
        // or a next_due_at sent alongside it would be a second, contradictory
        // schedule the scheduler never reads.
        const recurrence = serializeRoutineRule(routineRule, nextMs);
        const routine = await createRoutine(
          {
            title,
            cwd: cwd.trim(),
            prompt: raw,
            ...(recurrence
              ? { recurrence }
              : {
                  interval_secs: routineInterval,
                  ...(nextMs != null ? { next_due_at: nextMs } : {}),
                }),
            agent: mainAgentId || undefined,
            // The model picker stays visible in routine mode, so its value has
            // to travel with the schedule; dropping it made the control look
            // applied while every run started on the agent's default.
            ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
            permission_mode: permissionMode,
            project_id: project?.id,
          },
          machineId || undefined,
        );
        // The routine was created on that machine, so the Routines page opens
        // there. Without this the page would stay on whatever machine it was
        // last showing, and the routine just created would be missing from it.
        writeRoutineDevice(machineId || THIS_MACHINE);
        clearDraftPrompt();
        setAsRoutine(false);
        navigate(`/routines`, { replace: true, state: { createdId: routine.id } });
        pushToast(tr("routines.created"), "info");
      } catch (err) {
        // Hand it back: the composer restores the prompt and says what failed.
        throw err instanceof Error ? err : new Error(tr("routines.actionFailed"));
      } finally {
        setSending(false);
      }
      return;
    }
    if (available.length === 0) {
      throw new Error(
        remote ? tr("machine.noAgents", { name: machineLabel }) : tr("newChat.noAgents"),
      );
    }

    const plan = parseAgentDirective(raw, availableIds);

    // Main agent (user-facing host): honor the configured default. Worker
    // mentions never replace this session host.
    let agent: string = mainAgentId;
    // No main at all — last resort single @ worker as the whole session.
    if (!agent && plan.agent) agent = plan.agent;
    if (!agent) {
      throw new Error(tr("newChat.noAgentInstall"));
    }

    // Keep full raw prompt so backend can parse multi-@ plans.
    const prompt = raw;

    // Validate dispatch selection before submitting.
    const dispatchReady = !remote && isDispatchReady(dispatch, dispatchPreviewBlocked);
    if (dispatchBlocksSend(dispatch, { remote, previewBlocked: dispatchPreviewBlocked })) {
      throw new Error(tr("newChat.dispatchIncomplete"));
    }

    setSending(true);
    // The task does not exist yet, so its transcript cannot either: the
    // high-water mark is zero and the bubble settles on the first matching
    // user event the daemon writes.
    const sent = newPendingSend(raw, NO_EVENTS);
    setPendingSend(sent);
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
      // Seed the store with the row the create answer already carries: the
      // conversation route then draws its header and composer immediately
      // instead of waiting for a detail request for a task it just created.
      liveResources.applyTaskSnapshot(task, liveResources.currentRevision());
      // The same bubble travels with the route: the conversation mounts before
      // its detail answers, and it must draw the message the draft was already
      // showing rather than blink it away for one navigation plus one GET.
      handOffPendingSend(task.id, sent);
      clearDraftPrompt();
      // The draft is gone; returning to the list later should not put focus
      // back on the button that opened it.
      forgetPlaceReturn();
      navigate(`/tasks/${task.id}`, { replace: true });
    } catch (err) {
      // The composer owns the feedback for a rejected send; it also restores
      // the prompt this page cleared when the send started.
      setPendingSend(null);
      throw err instanceof Error ? err : new Error(tr("newChat.createFailed"));
    } finally {
      setSending(false);
    }
  }

  /** Where the run happens, behind the composer's one face: role, branch,
   *  dispatch and routine. The folder is not here — it names the conversation
   *  and sits under the card with the machine it belongs to, so "what this is
   *  about" and "where it runs" are two questions on two levels instead of
   *  nine equal rows. While routine mode is on the branch and dispatch rows step
   *  aside (a routine has no branch to switch, and the Hub's team dispatch
   *  does not cross machines). */
  const sheetExtraRows = (
    asRoutine ? (["routine"] as const) : (["role", "branch", "dispatch", "routine"] as const)
  ) as readonly NewChatControlId[];
  const visibleSheetExtraRows = sheetExtraRows.filter((id) => id !== "role" || roleList.length > 0);

  /** Each control's own row label. The group headings stay as sections
   *  ("Run", "Route", "Workspace"); this is what the row is asking for. */
  const CONTROL_LABEL_KEY: Record<NewChatControlId, string> = {
    permission: "newChat.rowPermission",
    routine: "newChat.rowRoutine",
    machine: "newChat.rowMachine",
    hostModel: "newChat.rowAgentModel",
    role: "newChat.rowRole",
    dispatch: "newChat.rowDispatch",
    cwd: "newChat.rowCwd",
    branch: "newChat.rowBranch",
  };

  function renderControl(control: NewChatControlId) {
    switch (control) {
      case "role":
        return (
          <SheetSelect
            key={control}
            label={tr("newChat.rowRole")}
            value={appliedRole(previewPrompt, roleList)?.id ?? ""}
            // "No role" is an option, not a placeholder: a control that can
            // only ever add text is a one-way door, and the way back is a tap
            // on the same row rather than editing the draft by hand.
            options={[
              { id: "", label: tr("newChat.roleNone") },
              ...roleList.map((role) => ({ id: role.id, label: role.name })),
            ]}
            placeholder={tr("newChat.roleNone")}
            disabled={sending}
            className="max-w-[12rem] text-kin-secondary"
            onChange={(id) => {
              // The draft is the truth. Picking a role writes its text into
              // the draft — the same text the transcript will show — instead
              // of attaching a setting that the run would apply invisibly.
              const next = selectRole(previewPrompt, roleList, id);
              setPreviewPrompt(next);
              setDraftPrompt(next);
              setDraftValue(next);
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
                ? "border-kin-blue/50 bg-kin-blue/15 text-kin-blue-ink"
                : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
            ].join(" ")}
          >
            <IconRoutines size={13} />
          </button>
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

  const disconnected = wsStatus === "disconnected";
  /** Why the start control is off, in the page's own words. Empty means ready. */
  const sendBlockReason = !cwd.trim()
    ? tr("newChat.chooseCwd")
    : machineGone
      ? tr("machine.goneHint", { name: machineId })
      : machineUnread
        ? tr("machine.listUnavailable")
        : remote && machine && !machine.online
          ? tr("machine.offlineHint", { name: machineLabel })
          : available.length === 0
            ? remote
              ? tr("machine.noAgents", { name: machineLabel })
              : tr("newChat.noAgents")
            : disconnected
              ? tr("newChat.disconnected")
              : "";

  return (
    <div className="flex-1 flex flex-col min-h-0 kin-surface-chat">
      {/* `gap-2` rather than a leading `ml-2` on each child: on a phone the
          title below is `display:none` and the first visible child would
          otherwise start 8px indented, past the gutter every other row uses. */}
      <div className="hidden md:flex h-11 flex-none items-center gap-2 px-4 sm:px-5 border-b border-[var(--kin-hairline)]">
        {/* The phone's shell header shows this same word (`nav.newChat` and
            `newChat.title` are one string), so only the rest of the row — who
            hosts the session, and where it runs — is worth the 44px there. It
            returns at `md`, where the shell header goes away. */}
        <div className="hidden text-strong font-semibold text-kin-text md:block">
          {tr("newChat.title")}
        </div>
        {/* Both labels are user data (an agent name, a machine name) in a
            single-line flex row. Without `min-w-0` a flex child refuses to
            shrink below its content, so a long name runs past the right edge
            and is clipped by `<main>` instead of ending in an ellipsis. */}
        {defaultAgent && (
          <div className="min-w-0 truncate text-body text-kin-muted">
            {tr("newChat.hostAgent", { name: defaultAgent.name })}
          </div>
        )}
        {remote ? (
          <div
            className="inline-flex min-w-0 items-center gap-1 text-body text-kin-secondary"
            title={tr("machine.remoteHint", { name: machineLabel })}
          >
            <IconMachine size={12} className="flex-none" />
            <span className="truncate">{tr("machine.runsOn", { name: machineLabel })}</span>
          </div>
        ) : null}
        {remote ? (
          <button
            type="button"
            onClick={refreshMachines}
            className="text-caption text-kin-blue-ink hover:underline"
          >
            {tr("machine.refresh")}
          </button>
        ) : null}
      </div>

      {/* One centered column: the greeting, the card that writes the run, and
          the place row under it. The card is the only thing on the screen with
          a border, so the eye lands on the prompt — the folder and the machine
          are one row beneath it, not four controls beside it. */}
      <div className="flex-1 overflow-y-auto kin-scroll">
        <div className="flex min-h-full items-center justify-center px-6 py-10 max-md:items-start max-md:px-5 max-md:pb-8 max-md:pt-8">
          <div className="w-full max-w-page-narrow">
            {pendingSend ? (
              <div className="pb-5">
                <ChatStream
                  events={NO_EVENTS}
                  fallbackUserPrompt={pendingSend.text}
                  loading
                  loadingSpeaker={mainAgentId}
                  hostSpeaker={mainAgentId}
                  hostModel={selectedModel || null}
                  messageScope="new-chat"
                />
              </div>
            ) : (
              <>
                <div className="text-center">
                  <h1 className="text-hero max-md:text-display font-semibold tracking-tight text-kin-text">
                    {tr("newChat.heroTitle")}
                  </h1>
                  {/* The phone's empty state is one line, not an essay: the card
                      below says who runs and how, and the frame keeps the input
                      visually central. The longer guidance is desktop reference
                      material, where the column has room for it. */}
                  <p className="mt-2 text-strong text-kin-secondary">
                    {tr("newChat.heroSubtitleHost")}
                  </p>
                  {available.length > 1 && (
                    <p className="hidden md:block mt-2 text-caption text-kin-muted">
                      {tr("newChat.hostPickerHint")}
                    </p>
                  )}
                  {(agents.some((a) => !a.available) || available.length === 0) && !remote && (
                    <div className="mt-2 flex justify-center">
                      <button
                        type="button"
                        className="min-h-11 px-3 text-body text-kin-blue-ink hover:underline sm:min-h-0 sm:px-0"
                        onClick={() => navigate("/agents", { replace: !wide })}
                      >
                        {tr("agents.manageLink")}
                      </button>
                    </div>
                  )}
                </div>

                {hints.length > 0 && (
                  // Desktop only: a line of @-mention hints is reference material,
                  // and on the phone it was the widest thing on the screen.
                  <div className="mt-6 hidden px-0.5 text-caption text-kin-muted sm:block">
                    {tr("newChat.tip", { hints: hints.join(" · ") })}
                  </div>
                )}
              </>
            )}

            <div data-kin-bottom-chrome="" className={hints.length > 0 ? "mt-2" : "mt-8"}>
              <Composer
                agents={agents}
                roles={agentRoles}
                hostAgentId={mainAgentId}
                busy={sending}
                disabled={sending}
                focusSignal={wide ? 1 : 0}
                blockSend={Boolean(sendBlockReason)}
                sendLabel={tr("newChat.start")}
                initialValue={draftValue}
                initialAttachments={initialAttachments}
                placeholder={
                  asRoutine
                    ? tr("routines.promptPlaceholder")
                    : tr("newChat.placeholder", { name: mainAgentName })
                }
                onAttachmentsChange={setDraftAttachments}
                onValueChange={(value) => {
                  setDraftValue(value);
                  setDraftPrompt(value);
                  setPreviewPrompt(value);
                }}
                onSubmit={onSubmit}
                footer={
                  // The page's only run control, at every width. The bottom row
                  // used to split into a phone face and a desktop strip of eight
                  // chips; on an iPad that strip was a sideways scroller and the
                  // same settings read as a different product from the phone's
                  // sheet. One face, one settings surface, and the strip is gone.
                  <RunConfigControl
                    agentName={mainAgentName}
                    agentId={mainAgentId}
                    agentAvatar={mainAgentAvatar}
                    model={selectedModel}
                    models={modelsForAgent(available, mainAgentId)}
                    onModelChange={setSelectedModel}
                    permission={permissionMode}
                    permissionModes={allowedPermissionModes}
                    onPermissionChange={(m) => {
                      setPermissionMode(m);
                      setDraftPermissionMode(m);
                    }}
                    disabled={sending}
                    agents={available}
                    onAgentChange={(id) => {
                      setSelectedHost(id);
                      setSelectedModel("");
                    }}
                    extraRows={
                      <>
                        {visibleSheetExtraRows.map((control) => (
                          <RunConfigSheetRow
                            key={control}
                            label={tr(CONTROL_LABEL_KEY[control])}
                            control={renderControl(control)}
                          />
                        ))}
                      </>
                    }
                  />
                }
                footerWide
              />
            </div>

            {!pendingSend && (
              <>
                {sendBlockReason ? (
                  <p role="status" className="mt-2 px-1 text-caption text-kin-secondary">
                    {sendBlockReason}
                  </p>
                ) : null}

                <div className="mt-3">
                  <PlacePicker
                    machines={machines}
                    value={{ machineId, cwd }}
                    dirs={dirs}
                    loading={machinesLoading}
                    failed={machinesFailed}
                    disabled={sending}
                    onRefresh={refreshMachines}
                    onChange={choosePlace}
                  />
                </div>
                {placeNotice ? (
                  <p className="mt-1.5 px-1 text-caption text-kin-orange-ink">{placeNotice}</p>
                ) : null}

                {asRoutine && (
                  <div className="mt-3 rounded-xl border border-kin-blue/25 bg-kin-blue/5 px-3 py-2.5">
                    <div className="mb-2 text-caption font-medium text-kin-blue-ink">
                      {tr("routines.routineModeOn")}
                    </div>
                    <RoutineScheduleFields
                      compact
                      disabled={sending}
                      intervalSecs={routineInterval}
                      onIntervalChange={setRoutineInterval}
                      nextRunLocal={routineNextLocal}
                      onNextRunLocalChange={setRoutineNextLocal}
                      rule={routineRule}
                      onRuleChange={setRoutineRule}
                    />
                  </div>
                )}

                {!remote && cwd.trim() ? (
                  <div className="mt-6">
                    {projectLookupState === "loading" ? (
                      <div className="rounded-xl border border-[var(--kin-hairline)] bg-kin-panel/60 px-4 py-5 text-center text-strong text-kin-muted">
                        {tr("newChat.projectSummaryLoading")}
                      </div>
                    ) : projectLookupState === "error" ? (
                      <div className="w-full rounded-2xl border border-kin-red/30 bg-kin-panel px-4 py-3 text-left">
                        <p className="text-body text-kin-red-ink">
                          {projectLookupError || tr("newChat.projectSummaryError")}
                        </p>
                        <button
                          type="button"
                          className="mt-2 text-body text-kin-blue-ink hover:underline"
                          onClick={() => setProjectLookupKey((k) => k + 1)}
                        >
                          {tr("common.retry")}
                        </button>
                      </div>
                    ) : project ? (
                      <ProjectSummaryCard project={project} summary={projectSummary} />
                    ) : (
                      <div className="hidden rounded-xl border border-dashed border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-4 py-5 text-center text-strong text-kin-secondary md:block">
                        {tr("newChat.onePagerNoProject", {
                          project: projectLabel(cwd),
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
