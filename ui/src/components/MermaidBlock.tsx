import { useEffect, useId, useRef, useState } from "react";

let mermaidReady: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      });
      return mod;
    });
  }
  return mermaidReady;
}

/**
 * Renders a Mermaid diagram from source text.
 * Lazy-loads the mermaid package so non-diagram chats stay light until needed.
 */
export default function MermaidBlock({
  code,
  className = "",
}: {
  code: string;
  className?: string;
}) {
  const reactId = useId().replace(/:/g, "");
  const renderSeq = useRef(0);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const src = code.trim();
    if (!src) {
      setSvg("");
      setError(null);
      setPending(false);
      return;
    }

    const seq = ++renderSeq.current;
    setPending(true);
    setError(null);

    void (async () => {
      try {
        const mermaid = (await loadMermaid()).default;
        const id = `kin-mermaid-${reactId}-${seq}`;
        const { svg: rendered } = await mermaid.render(id, src);
        if (!cancelled && seq === renderSeq.current) {
          setSvg(rendered);
          setPending(false);
        }
      } catch (err) {
        if (!cancelled && seq === renderSeq.current) {
          setError(err instanceof Error ? err.message : String(err));
          setPending(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <div
        className={[
          "overflow-x-auto rounded-lg border border-kin-red/40 bg-[var(--kin-fill)] p-3",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-kin-red">
          Mermaid
        </div>
        <p className="mb-2 text-[12px] text-kin-red">{error}</p>
        <pre className="whitespace-pre-wrap text-[12px] font-mono text-kin-secondary">
          {code}
        </pre>
      </div>
    );
  }

  if (pending || !svg) {
    return (
      <div
        className={[
          "rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-6 text-center text-[12px] text-kin-muted",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className={[
        "kin-mermaid overflow-x-auto rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      // mermaid.render returns SVG; securityLevel "strict" strips scripts.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
