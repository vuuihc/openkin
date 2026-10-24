const STYLES: Record<string, string> = {
  queued: "bg-kin-fill-strong text-kin-secondary border-kin-hairline-strong",
  running: "bg-kin-blue/15 text-kin-blue-ink border-kin-blue/30",
  waiting_approval: "bg-kin-orange/15 text-kin-orange-ink border-kin-orange/30",
  waiting_input: "bg-kin-orange/15 text-kin-orange-ink border-kin-orange/30",
  succeeded: "bg-kin-green/15 text-kin-green-ink border-kin-green/30",
  failed: "bg-kin-red/15 text-kin-red-ink border-kin-red/30",
  canceled: "bg-kin-fill-strong text-kin-muted border-kin-hairline-strong",
};

export default function StatusBadge({ status }: { status: string }) {
  const cls = STYLES[status] ?? STYLES.queued;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-body leading-4 font-medium capitalize ${cls}`}
    >
      {status === "running" && (
        <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-kin-blue" />
      )}
      {status.replace(/_/g, " ")}
    </span>
  );
}
