import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, type Project } from "../api/client";
import { MobileChevron } from "../components/mobile/MobileHeader";
import { useT } from "../i18n/react";

/** The API's four modes, labelled the way the cover labels them. */
const MODE_LABEL_KEY: Record<string, string> = {
  ship: "projects.modeShip",
  learn: "projects.modeLearn",
  explore: "projects.modeExplore",
  maintain: "projects.modeMaintain",
};

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
 * body, the title sits in its own `hidden md:block` block, and the rows are
 * full-width drill-in links on the page surface — not a phone card stranded in
 * a desktop column. The phone needs no second title because the shell's
 * `MobileHeader` already names the area at that width.
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
        {/* The shell's `MobileHeader` names the area at phone width; this block
            is the desktop page heading, and the only `h1` either way. */}
        <div className="hidden md:block">
          <h1 className="text-hero font-bold tracking-tight text-kin-text">{tr("nav.projects")}</h1>
        </div>
        {failed ? (
          // Visible text without a new live region: the inventory ratchet is flat
          // for this slice. The failure is still distinct from the empty state.
          <p className="text-body leading-5 text-kin-red-ink">{tr("projects.loadFailed")}</p>
        ) : projects === null ? (
          <p className="text-body leading-5 text-kin-muted">{tr("common.loading")}</p>
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
              const detail = [modeLabel, project.roots?.[0]].filter(Boolean).join(" · ");
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
                        {detail}
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
