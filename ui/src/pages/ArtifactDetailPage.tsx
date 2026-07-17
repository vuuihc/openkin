import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  formatBytes,
  getArtifact,
  getArtifactContent,
  getToken,
  setArtifactStatus,
  type Artifact,
} from "../api/client";
import { IconBack } from "../components/icons";
import Markdown from "../components/Markdown";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

/**
 * Artifact reader — Markdown/text via Markdown component; HTML in sandbox iframe.
 * Security: sandbox="" forbids scripts, same-origin, forms, popups.
 */
export default function ArtifactDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);

  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [archiving, setArchiving] = useState(false);
  const slow = useSlowHint(loading);

  const load = useCallback(async () => {
    if (!getToken() || !id) return;
    setLoading(true);
    try {
      const [meta, body] = await Promise.all([
        getArtifact(id),
        getArtifactContent(id),
      ]);
      setArtifact(meta);
      setContent(body);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        setError(tr("artifacts.notFound"));
      } else {
        setError(e instanceof Error ? e.message : tr("artifacts.loadFailed"));
      }
      setArtifact(null);
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [id, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  const onArchive = async () => {
    if (!artifact) return;
    setArchiving(true);
    try {
      const updated = await setArtifactStatus(artifact.id, "archived");
      setArtifact(updated);
      pushToast(tr("artifacts.archived"), "info");
      navigate("/artifacts");
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : tr("artifacts.archiveFailed"),
        "error",
      );
    } finally {
      setArchiving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col min-h-0 px-4 sm:px-6 py-6">
        {slow ? (
          <SlowConnectHint show />
        ) : (
          <div className="space-y-3 max-w-3xl">
            <SkeletonLine className="w-48 h-6" />
            <SkeletonLine className="w-full h-4" />
            <SkeletonLine className="h-4 w-5/6" />
            <SkeletonLine className="h-4 w-4/6" />
          </div>
        )}
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-[14px] text-kin-red">{error || tr("artifacts.notFound")}</p>
        <Link to="/artifacts" className="text-[13px] text-kin-blue hover:underline">
          {tr("artifacts.backToLibrary")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <header className="flex-none border-b border-[var(--kin-hairline)] px-3 sm:px-5 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/artifacts")}
          className="p-1.5 rounded-md text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill)]"
          aria-label={tr("artifacts.backToLibrary")}
        >
          <IconBack size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold truncate text-kin-text">
            {artifact.title}
          </h1>
          <p className="text-[11.5px] text-kin-muted truncate">
            {artifact.kind} · {formatBytes(artifact.size)}
            {artifact.source_task_id ? (
              <>
                {" · "}
                <Link
                  to={`/tasks/${artifact.source_task_id}`}
                  className="text-kin-blue hover:underline"
                >
                  {artifact.source_task_title || tr("artifacts.backToTask")}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {artifact.status !== "archived" && (
          <button
            type="button"
            disabled={archiving}
            onClick={() => void onArchive()}
            className="shrink-0 px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium text-kin-secondary hover:bg-[var(--kin-fill)] disabled:opacity-40"
          >
            {tr("artifacts.archive")}
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
        {artifact.kind === "html" ? (
          <iframe
            title={artifact.title}
            sandbox=""
            srcDoc={content ?? ""}
            className="w-full h-full min-h-[70vh] border-0 bg-white"
          />
        ) : artifact.kind === "text" ? (
          <pre className="max-w-3xl mx-auto px-4 sm:px-6 py-6 text-[13.5px] font-mono whitespace-pre-wrap text-kin-text">
            {content}
          </pre>
        ) : (
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
            <Markdown text={content ?? ""} />
          </div>
        )}
      </div>
    </div>
  );
}
