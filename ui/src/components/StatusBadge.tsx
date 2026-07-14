const STYLES: Record<string, string> = {
  queued: "bg-zinc-800 text-zinc-300 border-zinc-600",
  running: "bg-sky-950 text-sky-300 border-sky-700",
  waiting_approval: "bg-amber-950 text-amber-300 border-amber-700",
  succeeded: "bg-emerald-950 text-emerald-300 border-emerald-700",
  failed: "bg-red-950 text-red-300 border-red-800",
  canceled: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

export default function StatusBadge({ status }: { status: string }) {
  const cls = STYLES[status] ?? STYLES.queued;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {status === "running" && (
        <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      )}
      {status.replace(/_/g, " ")}
    </span>
  );
}
