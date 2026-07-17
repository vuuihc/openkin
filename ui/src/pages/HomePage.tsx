import { useNavigate } from "react-router-dom";
import { useState } from "react";
import NewTaskModal from "../components/NewTaskModal";
import Composer from "../components/chat/Composer";
import { IconKin } from "../components/icons";
import { useT } from "../i18n/react";

/**
 * Empty / first-run home (design 2c): welcome + sample prompts + composer.
 */
export default function HomePage() {
  const navigate = useNavigate();
  const tr = useT();
  const [modalOpen, setModalOpen] = useState(false);
  const [seedPrompt, setSeedPrompt] = useState("");

  const samples = [
    "Fix the flaky auth test in the kin repo",
    "Summarize what changed in main this week",
  ];

  function openWith(prompt: string) {
    setSeedPrompt(prompt);
    setModalOpen(true);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-kin-bg">
      <div className="flex-1 overflow-y-auto kin-scroll flex flex-col items-center justify-center px-6 py-10">
        <div className="w-[26px] h-[26px] rounded-[7px] bg-gradient-to-br from-[#5e5ce6] to-[#3a3a8c] flex items-center justify-center mb-4">
          <IconKin size={14} className="text-white" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight text-center max-w-md">
          {tr("home.slogan")}
        </h1>
        <p className="mt-2 text-[14px] text-kin-secondary text-center max-w-sm">
          {tr("home.subtitleSimple")}
        </p>
        <div className="mt-8 w-full max-w-[420px] space-y-2">
          {samples.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => openWith(s)}
              className="w-full text-left rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-4 py-3 text-[14px] text-kin-secondary hover:text-kin-text hover:bg-[var(--kin-fill-strong)]"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-none px-4 sm:px-7 pb-4 sm:pb-5 pt-2">
        <div className="max-w-[620px] mx-auto">
          <Composer onSubmit={(text) => openWith(text)} />
        </div>
      </div>

      <NewTaskModal
        open={modalOpen}
        initialPrompt={seedPrompt}
        onClose={() => {
          setModalOpen(false);
          setSeedPrompt("");
        }}
        onCreated={(t) => {
          setModalOpen(false);
          setSeedPrompt("");
          navigate(`/tasks/${t.id}`);
        }}
      />
    </div>
  );
}
