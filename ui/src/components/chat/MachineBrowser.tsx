import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  machineDirs,
  machineRepoBranches,
  prepareMachineRepo,
  type MachineRepoBranches,
} from "../../api/client";
import { useT } from "../../i18n/react";
import {
  emptyFolderNotice,
  folderPickable,
  repoAnswerFor,
  rootRowsVisible,
} from "../../lib/devices";
import { shortPath } from "../../lib/paths";

type Tab = "folders" | "repo";

type Props = {
  /**
   * The machine this is browsing. Empty or "self" is the daemon serving this
   * console; anything else is a machine the Hub has a channel to, and every
   * question about it is answered by that machine rather than by this one.
   */
  device?: string;
  /** Where to start, when the form already has a directory. */
  initialPath?: string;
  /** Called with a directory that is known to exist on that machine. */
  onPick: (path: string) => void;
  onClose: () => void;
  /** Offered as the way out for someone who already knows the path. */
  onTypePath?: () => void;
};

/**
 * Pick a working directory on a machine by looking at it.
 *
 * This is the phone's half of the cwd control, and the reason it exists is that
 * the other half is a native folder dialog: on a phone there is no such dialog,
 * and a machine that is not this one has no filesystem this console can read. So
 * the question goes to the machine over the channel it already dialled in on —
 * the machine answers where its own boundary is, and this draws the answer.
 *
 * The second tab is the same question asked the other way round: not "which
 * folder" but "which repository", for a machine that does not have it yet. Those
 * are one entry point rather than two because they end in the same place — a
 * directory to start a session in — and a person starting from a phone knows
 * which of the two they mean before they know the path.
 *
 * A modal rather than a popover: it is used on a phone, where it wants the whole
 * width, and it escapes the composer's `overflow-x-auto` strip by being fixed to
 * the viewport rather than laid out beside its trigger.
 */
export default function MachineBrowser({
  device,
  initialPath,
  onPick,
  onClose,
  onTypePath,
}: Props) {
  const tr = useT();
  const [tab, setTab] = useState<Tab>("folders");
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape and the opening focus belong to the panel being open, not to every
  // render. `onClose` is a fresh closure each time the parent renders — a
  // keystroke in the repo box is one — so an effect keyed on it re-arms the
  // focus timer on every keystroke and takes focus out of the input the person
  // is typing in. Holding the newest closure in a ref lets the effect run once.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => panelRef.current?.focus(), 20);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={tr("browse.title")}
    >
      <button
        type="button"
        aria-label={tr("browse.close")}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={[
          "relative flex flex-col w-full sm:max-w-md max-h-[80vh] outline-none",
          "rounded-t-2xl sm:rounded-2xl border border-[var(--kin-hairline-strong)]",
          "bg-kin-elevated shadow-e3 overflow-hidden",
        ].join(" ")}
      >
        <div className="flex-none flex items-center gap-1 border-b border-[var(--kin-hairline)] px-2 pt-2">
          {(["folders", "repo"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id}
              className={[
                "rounded-t-lg px-3 py-1.5 text-body font-medium transition-colors",
                tab === id
                  ? "text-kin-blue-ink border-b-2 border-kin-blue"
                  : "text-kin-muted border-b-2 border-transparent hover:text-kin-secondary",
              ].join(" ")}
            >
              {tr(id === "folders" ? "browse.folders" : "browse.repo")}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex-none px-2 py-1.5 text-body text-kin-muted hover:text-kin-secondary"
          >
            {tr("browse.close")}
          </button>
        </div>
        {tab === "folders" ? (
          <FolderTab device={device} initialPath={initialPath} onPick={onPick} />
        ) : (
          <RepoTab device={device} onPick={onPick} />
        )}
        {onTypePath && (
          <div className="flex-none border-t border-[var(--kin-hairline)] px-3 py-2">
            <button
              type="button"
              onClick={onTypePath}
              className="text-caption font-medium text-kin-blue-ink hover:underline"
            >
              {tr("browse.typePath")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the browser is, and what is inside it. */
function FolderTab({
  device,
  initialPath,
  onPick,
}: {
  device?: string;
  initialPath?: string;
  onPick: (path: string) => void;
}) {
  const tr = useT();
  const [path, setPath] = useState(initialPath ?? "");
  const [roots, setRoots] = useState<string[]>([]);
  const [parent, setParent] = useState("");
  const [entries, setEntries] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (next: string) => {
      setLoading(true);
      setError("");
      try {
        const answer = await machineDirs(device, next);
        // The machine reports the path as it was walked, which is the way the
        // person got here rather than the way the filesystem resolves it.
        setPath(answer.path ?? next);
        setRoots(answer.roots ?? []);
        setParent(answer.parent ?? "");
        setEntries(answer.entries ?? []);
        setTruncated(Boolean(answer.truncated));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : tr("browse.loadFailed"));
        setEntries([]);
        setParent("");
      } finally {
        setLoading(false);
      }
    },
    [device, tr],
  );

  // Where this machine may be looked at, learned separately from wherever the
  // browser starts. The roots are the one listing that does not depend on where
  // we were, and they have to survive the starting point being wrong: a
  // directory that has since been deleted, or a path remembered from another
  // machine, would otherwise be a dead end with nothing to tap — on the one
  // client that cannot type its way out.
  useEffect(() => {
    let live = true;
    void machineDirs(device, "").then(
      (answer) => {
        if (live) setRoots(answer.roots ?? []);
      },
      () => {
        /* The listing below reports the failure; this only feeds the shortcuts. */
      },
    );
    return () => {
      live = false;
    };
  }, [device]);

  // An empty path is not a directory: it is "where may I look at all". Starting
  // anywhere else is the same question asked from a place.
  useEffect(() => {
    void load(initialPath ?? "");
  }, [load, initialPath]);

  return (
    <>
      <div className="flex-none border-b border-[var(--kin-hairline)] px-3 py-2">
        <div
          className="truncate font-mono text-caption text-kin-secondary"
          title={path || undefined}
        >
          {path ? shortPath(path, 64) : tr("browse.roots")}
        </div>
      </div>

      <ul className="flex-1 min-h-0 overflow-y-auto py-1">
        {loading && <li className="px-3 py-2 text-body text-kin-muted">{tr("browse.loading")}</li>}
        {!loading && error && (
          <li className="px-3 py-2 text-body text-kin-orange-ink">
            <div>{tr("browse.loadFailed")}</div>
            {/* The machine's own words, kept rather than replaced: a directory
                this console cannot read may be gone, may be a file, may be
                outside the roots that machine allows, or may be on a machine
                that has since gone offline, and only the machine knows which. */}
            <div className="mt-0.5 text-caption text-kin-muted">{error}</div>
          </li>
        )}
        {!loading && (
          <>
            {/* The roots are offered wherever you are, not only at the top: a
                person who has tapped three levels down and wants the other
                repository on this machine should not have to walk back up. With
                one root and a directory under it there is nowhere else to go, so
                it is only worth a row when it is also the way out of a listing
                that failed — but at the roots question itself the roots are the
                answer, and the single root a fresh machine declares is the only
                way in. See rootRowsVisible. */}
            {rootRowsVisible({ path, roots, failed: Boolean(error) }) &&
              roots.map((root) => (
                <li key={`root:${root}`}>
                  <Row
                    label={shortPath(root, 40)}
                    hint={tr("browse.roots")}
                    current={!error && root === path}
                    onClick={() => void load(root)}
                  />
                </li>
              ))}
            {!error && parent && (
              <li>
                <Row
                  label={tr("browse.parent")}
                  hint={tr("browse.up")}
                  onClick={() => void load(parent)}
                />
              </li>
            )}
            {!error &&
              entries.map((name) => (
                <li key={name}>
                  <Row
                    label={name}
                    folder
                    onClick={() => void load(path ? `${path}/${name}` : name)}
                  />
                </li>
              ))}
            {emptyFolderNotice({
              path,
              roots,
              entries,
              failed: Boolean(error),
            }) && <li className="px-3 py-2 text-body text-kin-muted">{tr("browse.empty")}</li>}
            {!error && truncated && (
              <li className="px-3 py-2 text-caption text-kin-muted">
                {tr("browse.truncated", { count: String(entries.length) })}
              </li>
            )}
          </>
        )}
      </ul>

      <div className="flex-none border-t border-[var(--kin-hairline)] px-3 py-2">
        <button
          type="button"
          // Not pickable while the listing is in doubt: `path` is where the
          // person walked to, and it is only known to be a directory on that
          // machine because that machine listed it. A failed listing is exactly
          // the case where it is not, and handing it back as a cwd would start a
          // session somewhere that does not exist.
          disabled={!folderPickable({ path, loading, failed: Boolean(error) })}
          onClick={() => onPick(path)}
          className={[
            "w-full rounded-lg px-3 py-2 text-strong font-medium transition-colors",
            "bg-kin-blue text-kin-on-brand disabled:opacity-40",
          ].join(" ")}
        >
          {tr("browse.use")}
        </button>
      </div>
    </>
  );
}

/** Name a repository, and let the machine fetch it. */
function RepoTab({ device, onPick }: { device?: string; onPick: (path: string) => void }) {
  const tr = useT();
  const [repo, setRepo] = useState("");
  const [looked, setLooked] = useState<{ named: string; found: MachineRepoBranches } | null>(null);
  const [branch, setBranch] = useState("");
  // Asking for branches and fetching a repository are two different waits with
  // two different answers, and the buttons have to say which one is happening:
  // one flag for both left the fetch button reading "Fetching…" while the
  // machine was only being asked what branches exist, and left the lookup with
  // no sign that anything was happening at all.
  const [finding, setFinding] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");

  const named = repo.trim();
  const busy = finding || fetching;
  // What the machine answered about, if the box still names that repository:
  // see repoAnswerFor. Everything below reads this, so the branch list and the
  // fetch can only ever be about the text that is on screen now.
  const found = repoAnswerFor(looked, named);

  async function find() {
    if (!named || busy) return;
    setFinding(true);
    setError("");
    setLooked(null);
    setBranch("");
    try {
      const answer = await machineRepoBranches(device, named);
      setLooked({ named, found: answer });
      setBranch(answer.default_branch ?? answer.branches?.[0] ?? "");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : tr("browse.fetchFailed"));
    } finally {
      setFinding(false);
    }
  }

  async function fetchIt() {
    if (busy || !named) return;
    setFetching(true);
    setError("");
    try {
      // The repository is asked for in the words the machine answered with, not
      // the words that were typed: the machine decided what the name means on
      // itself, and this is that decision handed back. Only while the answer is
      // about the text still in the box — once the text has moved on, the
      // machine's words name a repository the person has stopped asking for, and
      // the branch that was chosen belongs to that other repository's answer.
      const prepared = await prepareMachineRepo(
        device,
        found?.clone_url ?? named,
        found ? branch : undefined,
      );
      onPick(prepared.path);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : tr("browse.fetchFailed"));
    } finally {
      setFetching(false);
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-caption text-kin-muted" htmlFor="kin-repo-name">
            {tr("browse.repoHint")}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="kin-repo-name"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void find();
                }
              }}
              placeholder={tr("browse.repoPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={[
                "flex-1 min-w-0 rounded-md border border-[var(--kin-hairline-strong)]",
                "bg-[var(--kin-fill)] px-2 py-1.5 text-body font-mono",
                "text-kin-text outline-none focus:border-kin-blue/50",
              ].join(" ")}
            />
            <button
              type="button"
              disabled={busy || !named}
              onClick={() => void find()}
              className="flex-none text-body font-medium text-kin-blue-ink disabled:opacity-40"
            >
              {finding ? tr("browse.finding") : tr("browse.findBranches")}
            </button>
          </div>
        </div>

        {found && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-kin-muted">{tr("browse.branch")}</span>
            {(found.branches ?? []).length === 0 ? (
              <span className="text-body text-kin-muted">{tr("browse.noBranches")}</span>
            ) : (
              <select
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className={[
                  "w-full rounded-md border border-[var(--kin-hairline-strong)]",
                  "bg-[var(--kin-fill)] px-2 py-1.5 text-body font-mono",
                  "text-kin-text outline-none focus:border-kin-blue/50",
                ].join(" ")}
              >
                {(found.branches ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name === found.default_branch ? tr("browse.defaultBranch", { name }) : name}
                  </option>
                ))}
              </select>
            )}
            {found.truncated && (
              <span className="text-caption text-kin-muted">
                {tr("browse.truncated", { count: String((found.branches ?? []).length) })}
              </span>
            )}
          </div>
        )}

        {error && <div className="text-body text-kin-orange-ink">{error}</div>}
      </div>

      <div className="flex-none border-t border-[var(--kin-hairline)] px-3 py-2">
        <button
          type="button"
          disabled={busy || !named}
          onClick={() => void fetchIt()}
          className="w-full rounded-lg px-3 py-2 text-strong font-medium bg-kin-blue text-kin-on-brand disabled:opacity-40"
        >
          {fetching ? tr("browse.fetching") : tr("browse.fetch")}
        </button>
      </div>
    </>
  );
}

function Row({
  label,
  hint,
  folder,
  current,
  onClick,
}: {
  label: string;
  hint?: string;
  folder?: boolean;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
        current ? "bg-kin-blue/15 text-kin-blue-ink" : "hover:bg-[var(--kin-fill)]",
      ].join(" ")}
    >
      {folder && <FolderIcon />}
      <span className="min-w-0 flex-1 truncate font-mono text-body text-kin-secondary">
        {label}
      </span>
      {hint && <span className="flex-none text-caption text-kin-muted">{hint}</span>}
    </button>
  );
}

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none opacity-60"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}
