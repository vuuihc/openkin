export default function ApprovalsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-50">Approvals</h1>
      <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 px-6 py-16 text-center">
        <p className="text-base font-medium text-zinc-200">Approvals come in M2</p>
        <p className="mt-1 text-sm text-zinc-500">
          Pending tool permissions will show up here for one-tap approve/deny.
        </p>
      </div>
    </div>
  );
}
