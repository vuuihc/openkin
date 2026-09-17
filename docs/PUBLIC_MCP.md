# Public OpenKin MCP

OpenKin exposes a public control-plane MCP endpoint at `POST /mcp`. It is
separate from the task-scoped `kin approve-mcp` bridge used by managed workers.

## Local stdio

Configure an MCP host to launch:

```text
kin mcp --scope read,write
```

The command reads the local daemon credential from `~/.kin/token`, proxies
JSON-RPC over stdio to the local daemon, and never returns that credential as a
tool result. Use `--scope read` for observation-only hosts. Add `admin` only
for a deliberately human-operated host that must process approvals or answer
task questions.

Optional flags:

```text
--daemon http://127.0.0.1:7777
--client claude-code
--scope read,write
```

## Streamable HTTP

Send MCP JSON-RPC requests to `/mcp` with the normal Kin bearer credential.
Set these headers for audit and scope selection:

```text
X-Kin-MCP-Client: codex-cli
X-Kin-MCP-Scopes: read
```

Device credentials are read-only. The daemon master credential may request
`read`, `write`, or explicit `admin` scope; omitted scopes default to
`read,write`, never `admin`.

## Tools

Read tools:

```text
list_tasks              get_task                 list_task_events
list_projects           list_artifacts            read_artifact
list_routines           get_usage                get_routing_status
```

Write tools:

```text
create_task             send_task_message         cancel_task
retry_task              continue_task             run_routine
```

Admin tools:

```text
approve_task_action     answer_task_question
resolve_idempotency
```

Responses are bounded. Artifact reads are restricted to the indexed artifact
storage root. Mutating retry-like tools require an `idempotency_key`; results
are persisted locally so a daemon restart does not replay a completed call.
If a process dies after claiming a key but before completing the operation,
only the explicit admin `resolve_idempotency(action=discard)` tool can clear
the pending record; automatic retries never discard or replay an unknown
side effect.
Every request is recorded with principal, client, method, scope, outcome, and a
request digest. Raw credentials and raw request bodies are not written to the
audit table.
