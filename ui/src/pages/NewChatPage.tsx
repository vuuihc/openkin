import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError,
  createTask,
  findProjectByRoot,
  listAgents,
  recentCwds,
  type AgentInfo,
  type OnePagerSummary,
  type Project,
} from "../api/client";
import BranchPicker from "../components/chat/BranchPicker";
import CwdPicker from "../components/chat/CwdPicker";
import Composer from "../components/chat/Composer";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import ModelPicker from "../components/chat/ModelPicker";
import ProjectSummaryCard from "../components/project/ProjectSummaryCard";
import { useT } from "../i18n/react";
import { agentCatalogState } from "../lib/agentCatalog";
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
  getDraftPrompt,
  setDraftAttachments,
  setDraftCwd,
  setDraftPrompt,
} from "../lib/draftChat";
import { projectLabel } from "../lib/paths";
import {
  getDraftPermissionMode,
  setDraftPermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
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
  const [initialAttachments] = useState(() => getDraftAttachments());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => getDraftPermissionMode(),
  );
  const [selectedModel, setSelectedModel] = useState("");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedHost, setSelectedHost] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [projectSummary, setProjectSummary] =
    useState<OnePagerSummary | null>(null);
  const [projectLookupState, setProjectLookupState] = useState<
    "idle" | "loading" | "ready" | "missing" | "error"
  >("idle");
  const [projectLookupError, setProjectLookupError] = useState<string | null>(
    null,
  );
  const [projectLookupKey, setProjectLookupKey] = useState(0);

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
    recentCwds()
      .then((dirs) => {
        setCwd((c) => {
          if (c) return c;
          const next = dirs[0] || "";
          if (next) setDraftCwd(next);
          return next;
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const q = params.get("q");
    if (q) {
      setInitialValue(q);
      setDraftPrompt(q);
    }
    const cwdParam = params.get("cwd");
    if (cwdParam) {
      setCwd(cwdParam);
      setDraftCwd(cwdParam);
    }
  }, [params]);

  // Resolve project summary for the selected cwd (read-only; never auto-create).
  useEffect(() => {
    const path = cwd.trim();
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
        setProjectLookupError(
          e instanceof Error ? e.message : tr("newChat.projectSummaryError"),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, projectLookupKey, tr]);

  const available = useMemo(
    () => agents.filter((a) => a.available),
    [agents],
  );
  const availableIds = useMemo(() => available.map((a) => a.id), [available]);
  const defaultAgent = available.find((a) => a.default) ?? available[0];
  // Prefer explicit host pick; else daemon default; else first available.
  const mainAgentId =
    (selectedHost && availableIds.includes(selectedHost) && selectedHost) ||
    defaultAgent?.id ||
    availableIds[0] ||
    "";
  const mainAgentMeta =
    available.find((a) => a.id === mainAgentId) ?? defaultAgent;
  const mainAgentName =
    mainAgentMeta?.name ?? agentDisplayName(mainAgentId || "agent");
  const mainAgentAvatar = agentAvatarMeta(mainAgentId || "agent");
  const hints = mentionHints(availableIds, mainAgentId);

  // Drop model selection when host agent changes to one without that model.
  useEffect(() => {
    const opts = modelsForAgent(available, mainAgentId);
    if (
      selectedModel &&
      opts.length > 0 &&
      !opts.some((m) => m.id === selectedModel)
    ) {
      setSelectedModel("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-check when host agent id changes
  }, [mainAgentId]);

  async function onSubmit(text: string) {
    const raw = text.trim();
    if (!raw) return;
    if (!cwd.trim()) {
      pushToast(tr("newChat.chooseCwd"), "error");
      return;
    }
    if (available.length === 0) {
      pushToast(tr("newChat.noAgents"), "error");
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
    setSending(true);
    setDraftPrompt(raw);
    try {
      const task = await createTask({
        agent,
        cwd: cwd.trim(),
        prompt,
        permission_mode: permissionMode,
        project_id: project?.id,
        ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
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
    project != null ||
    projectLookupState === "loading" ||
    projectLookupState === "error";

  return (
    <div className="flex-1 flex flex-col min-h-0 kin-surface-chat">
      <div className="h-11 flex-none flex items-center px-4 sm:px-5 border-b border-[var(--kin-hairline)]">
        <div className="text-[13.5px] font-semibold text-kin-text">
          {tr("newChat.title")}
        </div>
        {defaultAgent && (
          <div className="ml-2 text-[12px] text-kin-muted">
            {tr("newChat.hostAgent", { name: defaultAgent.name })}
          </div>
        )}
      </div>

      <div
        className={[
          "flex-1 overflow-y-auto kin-scroll flex flex-col items-center px-6 py-10",
          showProjectColumn ? "justify-start" : "justify-center",
        ].join(" ")}
      >
        <div
          className={`w-8 h-8 rounded-[9px] flex items-center justify-center mb-4 text-[12px] font-semibold ${mainAgentAvatar.className}`}
          aria-label={mainAgentAvatar.label}
        >
          {mainAgentAvatar.initials}
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight text-center max-w-md">
          {tr("newChat.heroTitle", { name: mainAgentName })}
        </h1>
        <p className="mt-2 text-[14px] text-kin-secondary text-center max-w-md">
          {tr("newChat.heroSubtitleHost", { name: mainAgentName })}
        </p>

        {available.length > 1 && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 max-w-lg">
            <span className="text-[11px] uppercase tracking-wide text-kin-muted mr-1">
              {tr("newChat.hostPicker")}
            </span>
            {available.map((a) => {
              const active = a.id === mainAgentId;
              const av = agentAvatarMeta(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setSelectedHost(a.id);
                    setSelectedModel("");
                  }}
                  className={[
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                    active
                      ? "border-kin-blue/50 bg-kin-blue/15 text-kin-text"
                      : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
                  ].join(" ")}
                  title={a.name}
                >
                  <span
                    className={`w-5 h-5 rounded-md flex items-center justify-center text-[9px] font-semibold ${av.className}`}
                  >
                    {av.initials}
                  </span>
                  {a.name}
                  {agentCatalogState(a) === "generic" && (
                    <span className="text-[10px] text-kin-muted" title={tr("agentCatalog.genericHint")}>
                      {tr("agentCatalog.generic")}
                    </span>
                  )}
                  {active && (
                    <span className="text-[10px] text-kin-blue">
                      {tr("newChat.roleHost")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {agents.some((a) => !a.available) && (
          <div className="mt-3">
            <button
              type="button"
              className="text-[12px] text-kin-blue hover:underline"
              onClick={() => navigate("/agents")}
            >
              {tr("agents.manageLink")}
            </button>
          </div>
        )}

        <div className="mt-8 w-full max-w-xl space-y-3">
          {!cwd.trim() ? (
            <div className="rounded-xl border border-dashed border-[var(--kin-hairline)] bg-[var(--kin-fill)]/60 px-4 py-5 text-center text-[13px] text-kin-secondary">
              {tr("newChat.noCwdHint")}
            </div>
          ) : projectLookupState === "loading" ? (
            <div className="rounded-xl border border-[var(--kin-hairline)] bg-kin-panel/60 px-4 py-5 text-center text-[13px] text-kin-muted">
              {tr("newChat.projectSummaryLoading")}
            </div>
          ) : projectLookupState === "error" ? (
            <div className="w-full rounded-2xl border border-red-500/30 bg-kin-panel px-4 py-3 text-left">
              <p className="text-[12.5px] text-red-500/90">
                {projectLookupError || tr("newChat.projectSummaryError")}
              </p>
              <button
                type="button"
                className="mt-2 text-[12px] text-kin-accent hover:underline"
                onClick={() => setProjectLookupKey((k) => k + 1)}
              >
                {tr("common.retry")}
              </button>
            </div>
          ) : project ? (
            <ProjectSummaryCard project={project} summary={projectSummary} />
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--kin-hairline)] bg-[var(--kin-fill)]/60 px-4 py-5 text-center text-[13px] text-kin-secondary">
              {tr("newChat.onePagerNoProject", {
                project: projectLabel(cwd),
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-none px-4 sm:px-7 pb-4 sm:pb-5 pt-2">
        <div className="max-w-[720px] mx-auto space-y-2">
          {hints.length > 0 && (
            <div className="text-[11.5px] text-kin-muted px-0.5">
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
            placeholder={tr("newChat.placeholder", { name: mainAgentName })}
            onAttachmentsChange={setDraftAttachments}
            onValueChange={setDraftPrompt}
            onSubmit={onSubmit}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-0.5">
            <PermissionModePicker
              value={permissionMode}
              disabled={sending}
              onChange={(m) => {
                setPermissionMode(m);
                setDraftPermissionMode(m);
              }}
            />
            <ModelPicker
              key={mainAgentId}
              value={selectedModel}
              models={modelsForAgent(available, mainAgentId)}
              source={mainAgentMeta?.model_list_source}
              status={mainAgentMeta?.model_list_status}
              disabled={sending}
              onChange={setSelectedModel}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
            <CwdPicker
              className="flex-1 min-w-[12rem]"
              cwd={cwd}
              locked={false}
              onChange={(v) => {
                setCwd(v);
                setDraftCwd(v);
              }}
            />
            <BranchPicker cwd={cwd} className="flex-none" />
          </div>
        </div>
      </div>
    </div>
  );
}
