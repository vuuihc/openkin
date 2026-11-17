import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useT } from "../../i18n/react";
import { cwdSuggestions, findMachine, type Machine } from "../../lib/devices";
import { projectLabel } from "../../lib/paths";
import { useMinWidth } from "../../hooks/useMinWidth";
import Sheet, { SheetSecondaryButton } from "../mobile/Sheet";
import { IconCheck, IconChevronDown, IconFolder } from "../icons";
import Button from "../ui/Button";
import Popover from "../ui/Popover";

export type Place = {
  /** "" names this machine, the same spelling the draft and the machine API use. */
  machineId: string;
  cwd: string;
};

type Props = {
  machines: Machine[];
  value: Place;
  /** Recent directories for this machine; another machine answers with its roots. */
  dirs: string[];
  loading?: boolean;
  failed?: boolean;
  disabled?: boolean;
  onRefresh?: () => void;
  onChange: (place: Place) => void;
};

type ProjectRow = { path: string; name: string };

/** A typed path is a place, not a filter; "alpha" is a filter. */
function directoryCandidate(query: string): string {
  const raw = query.trim();
  if (!raw) return "";
  if (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith(".")) return raw;
  return "";
}

/**
 * Where the work runs: one machine, one directory on it.
 *
 * The card above asks how the run happens; this row is the other question, so
 * it sits under the card instead of inside the run surface. Opening it groups
 * projects by machine — the frame's shape — and doubles as a directory field:
 * typing an absolute path offers it for the machine the row currently names.
 * The value is always a pair, so a path from another machine can never travel
 * alone.
 */
export default function PlacePicker({
  machines,
  value,
  dirs,
  loading,
  failed,
  disabled,
  onRefresh,
  onChange,
}: Props) {
  const tr = useT();
  const wide = useMinWidth(768);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The empty id names this machine — `findMachine` maps only real ids — so the
  // row can say "This machine" instead of leaving the name blank.
  const selected =
    value.machineId === ""
      ? machines.find((machine) => machine.isSelf)
      : findMachine(machines, value.machineId);
  const detecting = Boolean(loading) && machines.length === 0;
  const machineName = selected
    ? selected.isSelf
      ? tr("machine.thisMachine")
      : selected.label
    : value.machineId
      ? failed
        ? value.machineId
        : tr("machine.gone", { name: value.machineId })
      : "";
  const placeName = value.cwd ? projectLabel(value.cwd) : tr("newChat.placeNone");
  const label = detecting
    ? tr("newChat.placeChecking")
    : machineName
      ? `${machineName} · ${placeName}`
      : placeName;

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function pick(place: Place) {
    if (disabled) return;
    onChange(place);
    close();
  }

  const panel = (
    <PlacePanel
      machines={machines}
      value={value}
      dirs={dirs}
      failed={failed}
      wide={wide}
      disabled={disabled}
      onPick={pick}
      onCancel={() => close()}
    />
  );

  return (
    <div className="w-full">
      <Button
        ref={triggerRef}
        variant="secondary"
        disabled={disabled || detecting}
        onClick={() => setOpen((v) => !v)}
        aria-label={`${tr("newChat.placeTitle")}${tr("common.labelSeparator")}${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value.cwd || label}
        className="min-h-11! w-full justify-start rounded-xl px-3 text-left [&>span>span]:flex [&>span>span]:w-full [&>span>span]:items-center [&>span>span]:gap-2"
      >
        <IconFolder size={16} className="flex-none text-kin-secondary" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-kin-text">{label}</span>
        <span className="flex flex-none items-center gap-1 text-caption font-medium text-kin-blue-ink">
          {tr("newChat.placeChange")}
          <IconChevronDown size={11} className="opacity-70" />
        </span>
      </Button>
      {failed ? (
        <p className="mt-1.5 px-1 text-caption text-kin-muted">
          {tr("machine.listUnavailable")}{" "}
          {onRefresh ? (
            <Button
              variant="quiet"
              className="inline min-h-0! p-0 text-kin-blue-ink! hover:bg-transparent! hover:underline"
              onClick={onRefresh}
            >
              {tr("machine.refresh")}
            </Button>
          ) : null}
        </p>
      ) : null}

      {/*
        The desktop surface is the shared layer: one body portal, one viewport
        measurement, one Escape and one focus contract with every other
        popover. The panel draws no inner padding of its own, so `padded={false}`
        keeps today's geometry. The phone keeps its `Sheet` below.
      */}
      <Popover
        open={open && wide}
        // `Popover` only asks to close. Focus follows an outside press on its
        // own, and the layer restores it to the trigger on Escape, so this must
        // not pull it back to the trigger as well.
        onOpenChange={() => close(false)}
        triggerRef={triggerRef}
        label={tr("newChat.placeTitle")}
        placement="below"
        align="left"
        width={480}
        maxWidth={520}
        maxHeight={460}
        padded={false}
        className="flex flex-col overflow-hidden"
      >
        {panel}
      </Popover>

      {!wide ? (
        <Sheet
          open={open}
          onClose={() => close(false)}
          title={tr("newChat.placeTitle")}
          footer={
            <SheetSecondaryButton onClick={() => close()}>
              {tr("common.cancel")}
            </SheetSecondaryButton>
          }
        >
          {panel}
        </Sheet>
      ) : null}
    </div>
  );
}

function PlacePanel({
  machines,
  value,
  dirs,
  failed,
  wide,
  disabled,
  onPick,
  onCancel,
}: {
  machines: Machine[];
  value: Place;
  dirs: string[];
  failed?: boolean;
  wide: boolean;
  disabled?: boolean;
  onPick: (place: Place) => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // On desktop (`wide`), `Popover` already focuses the first focusable
    // element (`searchRef`) once anchored; a delayed focus there races
    // immediate ArrowDown navigation. Keep the 20 ms beat only for the
    // phone `Sheet` (whose 0 ms panel focus would otherwise win), and do
    // not pull focus back if the user already moved into the option list.
    if (wide) return;
    const timer = window.setTimeout(() => {
      if (listRef.current?.contains(document.activeElement)) return;
      searchRef.current?.focus({ preventScroll: true });
    }, 20);
    return () => window.clearTimeout(timer);
  }, [wide]);

  const q = query.trim().toLowerCase();
  const directory = directoryCandidate(query);
  const groups = useMemo(
    () =>
      machines
        .map((machine) => {
          const name = machine.isSelf ? tr("machine.thisMachine") : machine.label;
          const machineMatches =
            !q || `${name} ${machine.label} ${machine.id}`.toLowerCase().includes(q);
          const projects: ProjectRow[] = cwdSuggestions(machine, dirs)
            .filter(Boolean)
            .map((path) => ({ path, name: projectLabel(path) }))
            .filter(
              (project) =>
                machineMatches || `${project.name} ${project.path}`.toLowerCase().includes(q),
            );
          return { machine, name, projects, machineMatches };
        })
        .filter((group) => group.machineMatches || group.projects.length > 0),
    [machines, dirs, q, tr],
  );

  function focusFirst() {
    listRef.current
      ?.querySelector<HTMLButtonElement>("[data-place-option]")
      ?.focus({ preventScroll: true });
  }

  function moveFocus(delta: number) {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-place-option]") ?? [],
    );
    if (options.length === 0) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = at === -1 ? 0 : Math.min(Math.max(at + delta, 0), options.length - 1);
    options[next]?.focus({ preventScroll: true });
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusFirst();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // Nothing typed, nothing chosen: a bare Enter on the auto-focused field
      // must not silently move the place to whatever row happens to be first.
      if (!query.trim()) return;
      // The typed directory is the first row when there is one, so the field
      // and the keyboard reach the same option by the same click.
      listRef.current?.querySelector<HTMLButtonElement>("[data-place-option]")?.click();
    }
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const nothing =
    groups.length === 0 && !directory && (q !== "" || machines.length === 0 || failed);

  return (
    <>
      <div className="flex-none border-b border-[var(--kin-hairline)] p-2">
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label={tr("newChat.placeSearch")}
          placeholder={tr("newChat.placeSearch")}
          className="h-9 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 text-body text-kin-text outline-none placeholder:text-kin-muted focus:border-kin-blue/40"
        />
      </div>

      {/* A bare listbox inside a sheet reads as an open nested layer to
          `Sheet`'s Escape disambiguation, which then refuses to close the
          sheet. The list is content, not a layer, so it only carries listbox
          semantics in the anchored desktop panel — the same reason the folder
          browser's option list has no listbox role. */}
      <div
        ref={listRef}
        role={wide ? "listbox" : undefined}
        aria-label={wide ? tr("newChat.placeTitle") : undefined}
        className="min-h-0 flex-1 overflow-y-auto kin-scroll p-1"
        onKeyDown={onListKeyDown}
      >
        {directory ? (
          // A row in the option list, not an action button: the facade's
          // button typography and centred flex would corrupt the row.
          // eslint-disable-next-line kin/no-raw-button -- an option row in the listbox
          <button
            type="button"
            data-place-option=""
            role={wide ? "option" : undefined}
            aria-selected={wide ? false : undefined}
            disabled={disabled}
            onClick={() => onPick({ machineId: value.machineId, cwd: directory })}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body text-kin-text hover:bg-[var(--kin-fill-strong)] focus:bg-[var(--kin-fill-strong)] focus:outline-none"
          >
            <IconFolder size={14} className="flex-none text-kin-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {tr("newChat.placeUse", { path: directory })}
            </span>
          </button>
        ) : null}

        {groups.map(({ machine, name, projects, machineMatches }) => {
          const header = `${name} · ${
            machine.online ? tr("newChat.placeOnline") : tr("machine.offline")
          }`;
          return (
            <div key={machine.id || "__self"} role="group" aria-label={header} className="mb-1">
              <div
                className={[
                  "px-2 pb-1 pt-1.5 text-caption font-medium",
                  machine.online ? "text-kin-secondary" : "text-kin-orange-ink",
                ].join(" ")}
              >
                {header}
              </div>
              {projects.length === 0 ? (
                <p className="px-2 py-1 text-caption text-kin-muted">
                  {machineMatches ? tr("newChat.placeNoProjects") : tr("newChat.placeNoMatch")}
                </p>
              ) : (
                projects.map((project) => {
                  const selected =
                    (machine.isSelf ? "" : machine.id) === value.machineId &&
                    project.path === value.cwd;
                  return (
                    // eslint-disable-next-line kin/no-raw-button -- an option row in the listbox
                    <button
                      key={`${machine.id}\u0000${project.path}`}
                      type="button"
                      data-place-option=""
                      role={wide ? "option" : undefined}
                      aria-selected={wide ? selected : undefined}
                      aria-current={!wide && selected ? "true" : undefined}
                      disabled={disabled}
                      onClick={() =>
                        onPick({ machineId: machine.isSelf ? "" : machine.id, cwd: project.path })
                      }
                      className={[
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                        "hover:bg-[var(--kin-fill-strong)] focus:bg-[var(--kin-fill-strong)] focus:outline-none",
                        selected ? "bg-[var(--kin-fill-strong)]" : "",
                      ].join(" ")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-kin-text">
                          {project.name}
                        </span>
                        <span className="block truncate text-caption text-kin-muted">
                          {project.path}
                        </span>
                      </span>
                      {selected ? (
                        <IconCheck size={13} className="flex-none text-kin-blue-ink" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          );
        })}

        {nothing ? (
          <p className="px-2 py-2 text-caption text-kin-muted">
            {failed ? tr("machine.listUnavailable") : tr("newChat.placeNoMatch")}
          </p>
        ) : null}
      </div>

      {/* The keyboard line is for the desktop panel; a phone sheet showing
          "↑/↓" and "Esc" would be teaching keys that are not there. */}
      {wide ? (
        <div className="flex-none border-t border-[var(--kin-hairline)] px-2.5 py-1.5 text-caption text-kin-muted">
          {tr("newChat.placeHint")}
        </div>
      ) : null}
    </>
  );
}
