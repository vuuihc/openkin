# ADR 0018: Persisted Worker Steps and Workspace Access

## Status

Accepted for the M3 core supervision slice.

## Decision

Multi-worker orchestration keeps one user-visible Task and one authoritative
workspace generation, while persisting each delegated plan step under the
top-level execution identity:

- plan rows are append-only per `(task_id, execution_id, step_index)`;
- each row records role, dependencies, agent/provider/model, `read|write`
  workspace access, execution identity, attempt, status, and bounded result
  summary;
- the plan is persisted before the first worker starts;
- independent `read` steps may share a wave;
- a `write` step is isolated in its own wave, so two writers never mutate the
  same active generation concurrently;
- worker-step state is observable through the Task detail API/UI and the
  read-scoped public MCP tool;
- a task deletion cascades its worker plan history.

The engine remains responsible for step scheduling and worker lifecycle.
Adapters do not receive a new workflow API and continue to operate on the
resolved task workspace.

## Consequences

Restart and review paths can identify which workers were planned, running, or
completed without reconstructing state from volatile event streams. A
conservative access inference may serialize work that could technically run in
parallel; this is preferable to concurrent writes until explicit coordinator
controls and richer access declarations are added.

GitHub/GitLab branch publication, pull-request handoff, and per-worker
pause/retry controls remain later M3 work. Local task completion does not
depend on those integrations.
