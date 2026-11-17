import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, type Project } from "../api/client";
import { MobileChevron } from "../components/mobile/MobileHeader";
import { PageListSkeleton } from "../components/Skeleton";
import { useT } from "../i18n/react";

/** The API's four modes, labelled the way the cover labels them. */
const MODE_LABEL_KEY: Record<string, string> = {
  ship: "projects.modeShip",
  learn: "projects.modeLearn",
  explore: "projects.modeExplore",
  maintain: "projects.modeMaintain",
};

/**
 * How much of a root the secondary line shows before the middle gives way.
 *
 * A phone row is ~330px wide, so a seed path (`/var/folders/…/…/alpha`) loses
 * its ending to a plain ellipsis — and the ending is the part that tells two
 * projects apart. Keeping the head and the last segments leaves the basename
 * on screen; the full path stays in the link's accessible name.
 */
const PATH_BUDGET = 44;

/** Middle-truncate a path, keeping its basename and parent directory visible. */
export function middleTruncatePath(path: string, budget = PATH_BUDGET): string {
  if (path.length <= budget) return path;
  const basenameAt = path.lastIndexOf("/");
  const parentAt = path.lastIndexOf("/", basenameAt - 1);
  // The last two segments are what a reader scans; if they alone overrun the
  // budget, keep their ending rather than starting mid-path.
  const tailStart = budget - 12;
  const twoSegments = parentAt > 0 ? path.slice(parentAt) : "";
  const tail =
    twoSegments && twoSegments.length <= tailStart ? twoSegments : path.slice(-tailStart);
  return `${path.slice(0, Math.max(1, budget - tail.length - 1))}…${tail}`;
}

/**
 * `/projects` is the Projects area root: the collection the area table names.
 *
 * The area has owned a detail page (`/projects/:id`) all along, but its root
 * had no URL — a bookmark, a notification or a cold start in the area had
 * nowhere to land, and the command palette had no destination to offer. This
 * host is deliberately thin, the same shape as `SessionsRoute`: it asks the one
 * collection question and hands each row to the detail page that already owns
 * everything about a project.
 *
 * The frame is the one Routines and Chats use: the page is the only scroll
 * body, the title is the page's own `h1` at every width, and the rows are
 * full-width drill-in links on the page surface — not a phone card stranded in
 * a desktop column. The shell bar carries an area title only for `/agents` and
 * `/routines`; on `/projects` it names the app, so this heading has to stay
 * visible at phone width instead of hiding below `md`.
 *
 * Empty, loading and failed are three different answers and are drawn as such.
 * "No projects yet" over a failed read would be a lie about the reader's data.
 */
export default function ProjectsCollectionPage() {
  const tr = useT();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listProjects("active")
      .then((list) => {
        if (live) setProjects(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden kin-scroll">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6 md:px-6">
        {/* The only `h1`, and visible at every width: the shell bar says "Kin"
            on `/projects`, so hiding this below `md` would leave no title. */}
        <h1 className="text-hero font-bold tracking-tight text-kin-text">{tr("nav.projects")}</h1>
        {failed ? (
          // Visible text without a new live region: the inventory ratchet is flat
          // for this slice. The failure is still distinct from the empty state.
          <p className="text-body leading-5 text-kin-red-ink">{tr("projects.loadFailed")}</p>
        ) : projects === null ? (
          <PageListSkeleton variant="rows" rows={4} label={tr("common.loading")} />
        ) : projects.length === 0 ? (
          <p className="text-body leading-5 text-kin-muted">{tr("projects.empty")}</p>
        ) : (
          // Rows are direct children of the list, on the page surface: the row
          // shape Chats and Routines use, not a card inside the page. The
          // negative gutter lets the hover wash reach past the text edge while
          // the titles stay on the heading's left line.
          <div data-projects-list="" className="flex flex-col">
            {projects.map((project) => {
              const modeLabel = MODE_LABEL_KEY[project.mode]
                ? tr(MODE_LABEL_KEY[project.mode])
                : project.mode;
              const root = project.roots?.[0];
              const detail = [modeLabel, root].filter(Boolean).join(" · ");
              return (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="-mx-2 flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left kin-row-press hover:bg-[var(--kin-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin-focus-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-subtitle font-medium leading-ui text-kin-text">
                      {project.name}
                    </span>
                    {detail ? (
                      <span className="mt-0.5 block truncate text-caption leading-ui text-kin-muted">
                        {modeLabel}
                        {root ? (
                          <>
                            {modeLabel ? " · " : null}
                            {/* Visible: a middle truncation, so the basename
                                survives a narrow row. Hidden: the whole path,
                                so the link's name still says where it lives. */}
                            <span aria-hidden="true">{middleTruncatePath(root)}</span>
                            <span className="sr-only">{root}</span>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  <MobileChevron />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
