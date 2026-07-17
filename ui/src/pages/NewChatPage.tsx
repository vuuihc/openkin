import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError,
  createTask,
  listAgents,
  recentCwds,
  type AgentInfo,
} from "../api/client";
import CwdPicker from "../components/chat/CwdPicker";
import Composer from "../components/chat/Composer";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import { IconKin } from "../components/icons";
import { useT } from "../i18n/react";
import {
  mentionHints,
  parseAgentDirective,
} from "../lib/agentMention";
import {
  clearDraftPrompt,
  getDraftCwd,
  getDraftPrompt,
  setDraftCwd,
  setDraftPrompt,
} from "../lib/draftChat";
import {
  getDraftPermissionMode,
  setDraftPermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import { useAppStore } from "../store/appStore";

/**
 * New session: user talks to the configured main agent.
 * Multi-@ prompts are orchestrated by the daemon (sub-agents = task workers only).
 */
export default function NewChatPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const pushToast = useAppStore((s) => s.pushToast);
  const tr = useT();

  const [cwd, setCwd] = useState(() => getDraftCwd());
  const [initialValue, setInitialValue] = useState(() => getDraftPrompt());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => getDraftPermissionMode(),
  );
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sending, setSending] = useState(false);

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

  const available = useMemo(
    () => agents.filter((a) => a.available),
    [agents],
  );
  const availableIds = useMemo(() => available.map((a) => a.id), [available]);
  const defaultAgent =
    available.find((a) => a.default) ??
    available.find((a) => a.id === "kin") ??
    available[0];
  const hints = mentionHints(availableIds);

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
    const mainAgent =
      defaultAgent?.id ||
      (availableIds.includes("kin") && "kin") ||
      availableIds[0];

    let agent: string = mainAgent;
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

  const samples = [
    tr("newChat.samples.summarize"),
    tr("newChat.samples.fixTest"),
    tr("newChat.samples.multiAgent"),
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0 kin-surface-chat">
      <div className="h-11 flex-none flex items-center px-4 sm:px-5 border-b border-[var(--kin-hairline)]">
        <div className="text-[13.5px] font-semibold text-kin-text">
          {tr("newChat.title")}
        </div>
        {defaultAgent && (
          <div className="ml-2 text-[12px] text-kin-muted">
            {tr("newChat.mainAgent", { name: defaultAgent.name })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto kin-scroll flex flex-col items-center justify-center px-6 py-10">
        <div className="w-[26px] h-[26px] rounded-[7px] bg-gradient-to-br from-[#5e5ce6] to-[#3a3a8c] flex items-center justify-center mb-4">
          <IconKin size={14} className="text-white" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight text-center max-w-md">
          {tr("home.slogan")}
        </h1>
        <p className="mt-2 text-[14px] text-kin-secondary text-center max-w-md">
          {tr("home.subtitle")}
        </p>

        {agents.length > 0 && (
          <div className="mt-5 flex flex-wrap justify-center gap-1.5">
            {agents.map((a) => (
              <span
                key={a.id}
                className={[
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] border",
                  a.available
                    ? a.id === defaultAgent?.id
                      ? "border-kin-blue/50 bg-kin-blue-soft text-kin-blue"
                      : "border-kin-blue/30 bg-kin-blue-soft/60 text-kin-blue"
                    : "border-[var(--kin-hairline)] text-kin-muted",
                ].join(" ")}
              >
                <span
                  className={[
                    "w-1.5 h-1.5 rounded-full",
                    a.available ? "bg-kin-green" : "bg-kin-muted",
                  ].join(" ")}
                />
                {a.name}
                {a.id === defaultAgent?.id
                  ? ` · ${tr("newChat.roleMain")}`
                  : ` · ${tr("newChat.roleWorker")}`}
              </span>
            ))}
          </div>
        )}

        <div className="mt-8 w-full max-w-[480px] space-y-2">
          {samples.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void onSubmit(s)}
              disabled={sending}
              className="w-full text-left rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-4 py-3 text-[13.5px] text-kin-secondary hover:text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-none px-4 sm:px-7 pb-4 sm:pb-5 pt-2">
        <div className="max-w-[720px] mx-auto space-y-2">
          {hints.length > 0 && (
            <div className="text-[11.5px] text-kin-muted px-0.5">
              {tr("newChat.tip", {
                hints: hints.filter((h) => h !== "@kin").join(" · "),
              })}
            </div>
          )}
          <Composer
            agents={agents}
            busy={sending}
            disabled={sending}
            initialValue={initialValue}
            placeholder={tr("newChat.placeholder")}
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
          </div>
          <CwdPicker
            cwd={cwd}
            locked={false}
            onChange={(v) => {
              setCwd(v);
              setDraftCwd(v);
            }}
          />
        </div>
      </div>
    </div>
  );
}
