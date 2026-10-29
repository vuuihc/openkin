import type { ReactNode } from "react";
import { useT } from "../../i18n/react";
import type { SwitcherRow, SwitcherStatus } from "../../lib/sessionSwitcher";
import { IconSpinner } from "../icons";
import Sheet from "./Sheet";

/**
 * The phone's session switcher: what is open, what happened while you were
 * away, and one tap to either.
 *
 * The strip above the chat is desktop-only, so on a phone the only way between
 * two live sessions used to be back → list → open. This sheet is that strip's
 * phone shape, and it carries the two things a bare list of names cannot: a
 * session blocked on an approval is marked before it is opened (that is the
 * one state that cannot resolve itself), and a finished session nobody has
 * read yet is marked as new.
 *
 * It renders every row as a button rather than a link: switching is a state
 * change in the shell above the routes, and a link would push a history entry
 * per switch — the back gesture would then walk through every session visited
 * instead of leaving the conversation.
 */
export default function SessionSwitcherSheet({
  open,
  onClose,
  rows,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  rows: readonly SwitcherRow[];
  onSelect: (taskId: string) => void;
}) {
  const tr = useT();
  const openRows = rows.filter((row) => row.open);
  const recentRows = rows.filter((row) => !row.open);
  return (
    <Sheet open={open} onClose={onClose} title={tr("switcher.title")} bodyClassName="pb-3">
      {openRows.length > 0 && (
        <Section label={tr("switcher.open")}>
          {openRows.map((row) => (
            <Row key={row.id} row={row} onSelect={onSelect} />
          ))}
        </Section>
      )}
      {recentRows.length > 0 && (
        <Section label={tr("switcher.recent")}>
          {recentRows.map((row) => (
            <Row key={row.id} row={row} onSelect={onSelect} />
          ))}
        </Section>
      )}
    </Sheet>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="pt-2 first:pt-0">
      <h3 className="px-2 pb-1 text-caption font-medium text-kin-muted">{label}</h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function Row({ row, onSelect }: { row: SwitcherRow; onSelect: (taskId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        aria-current={row.active ? "true" : undefined}
        className={[
          "flex min-h-11 w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left transition-colors",
          row.active
            ? "bg-kin-blue/15"
            : "hover:bg-[var(--kin-fill)] active:bg-[var(--kin-fill)]",
        ].join(" ")}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-kin-text">{row.title}</span>
          {row.project ? (
            <span className="block truncate text-caption text-kin-muted">{row.project}</span>
          ) : null}
        </span>
        <StatusMark status={row.status} />
      </button>
    </li>
  );
}

function StatusMark({ status }: { status: SwitcherStatus }) {
  const tr = useT();
  switch (status) {
    case "waiting":
      return (
        <span className="flex-none rounded-full border border-kin-orange/40 bg-kin-orange/10 px-2 py-px text-caption font-medium text-kin-orange-ink">
          {tr("switcher.waiting")}
        </span>
      );
    case "running":
      return (
        <span
          role="img"
          aria-label={tr("switcher.running")}
          title={tr("switcher.running")}
          className="flex-none text-kin-blue"
        >
          <IconSpinner size={14} />
        </span>
      );
    case "failed":
      return (
        <span
          role="img"
          aria-label={tr("switcher.failed")}
          title={tr("switcher.failed")}
          className="h-2 w-2 flex-none rounded-full bg-kin-red"
        />
      );
    case "unread":
      return (
        <span
          role="img"
          aria-label={tr("switcher.unread")}
          title={tr("switcher.unread")}
          className="h-2 w-2 flex-none rounded-full bg-kin-green"
        />
      );
    default:
      return null;
  }
}
