import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects, type Project } from "../api/client";
import { useT } from "../i18n/react";

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
    <div className="flex-1 overflow-y-auto kin-scroll px-4 sm:px-6 py-6 space-y-4">
      <h1 className="text-hero font-bold">{tr("nav.projects")}</h1>
      {failed ? (
        // Visible text without a new live region: the inventory ratchet is flat
        // for this slice, and the real collection page (P2) owns the shared
        // error surface. The failure is still distinct from the empty state.
        <p className="text-body leading-5 text-kin-red-ink">{tr("projects.loadFailed")}</p>
      ) : projects === null ? (
        <p className="text-body leading-5 text-kin-muted">{tr("common.loading")}</p>
      ) : projects.length === 0 ? (
        <p className="text-body leading-5 text-kin-muted">{tr("projects.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/projects/${project.id}`}
                className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 py-2 text-strong hover:bg-[var(--kin-fill)]"
              >
                <span className="min-w-0 truncate">{project.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
