import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, type Project } from "../api/client";
import { MobileCard } from "../components/mobile/MobileList";
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
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="mx-auto flex w-full max-w-page flex-col gap-5 py-6 sm:py-8">
        <h1 className="px-4 text-hero font-bold sm:px-6">{tr("nav.projects")}</h1>
        {failed ? (
          // Visible text without a new live region: the inventory ratchet is flat
          // for this slice, and the real collection page (P2) owns the shared
          // error surface. The failure is still distinct from the empty state.
          <p className="px-4 text-body leading-5 text-kin-red-ink sm:px-6">
            {tr("projects.loadFailed")}
          </p>
        ) : projects === null ? (
          <p className="px-4 text-body leading-5 text-kin-muted sm:px-6">{tr("common.loading")}</p>
        ) : projects.length === 0 ? (
          <p className="px-4 text-body leading-5 text-kin-muted sm:px-6">{tr("projects.empty")}</p>
        ) : (
          // `sm:mx-6`: the card's own `mx-4` is the phone gutter, which matches
          // the heading's `px-4`; at the wider breakpoint both move to 24px.
          // (`mx-0` would lose to `mx-4` in the generated stylesheet.)
          <MobileCard className="sm:mx-6">
            {projects.map((project) => {
              const modeLabel = MODE_LABEL_KEY[project.mode]
                ? tr(MODE_LABEL_KEY[project.mode])
                : project.mode;
              const detail = [modeLabel, project.roots?.[0]].filter(Boolean).join(" · ");
              return (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left kin-row-press"
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
          </MobileCard>
        )}
      </div>
    </div>
  );
}
