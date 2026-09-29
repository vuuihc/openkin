import Foundation
import SwiftUI

/// Projection helpers for rendering task events as a transcript.
enum EventProjection {
    /// How a row is drawn in the conversation.
    enum RowStyle: Equatable {
        /// The person speaking: a bubble on the trailing edge.
        case user
        /// An agent speaking: a bubble on the leading edge.
        case agent
        /// Collapsed agent process work: reasoning, tools, and progress notes.
        case process
        /// Everything else — tool work, errors, approvals, plumbing: a compact
        /// row that reads as part of the transcript without being a turn.
        case notice
    }

    /// One step inside a collapsed process row.
    struct ProcessStep: Identifiable, Equatable {
        enum Kind: Equatable {
            case note
            case tool
        }

        enum Status: Equatable {
            case running
            case done
            case error
        }

        let id: String
        let kind: Kind
        let label: String
        let detail: String
        let expandedDetail: String?
        let status: Status
    }

    /// Display-ready row model for a single task event.
    struct DisplayRow: Identifiable {
        let id: String
        let seq: Int
        let timestamp: Date
        let icon: String
        let iconColor: Color
        let primaryText: String
        let secondaryText: String?
        let style: RowStyle
        /// The agent that produced an `agent` row, for labelling whose turn it is.
        let speaker: String?
        let level: String?
        let isCollapsible: Bool
        let rawContent: TaskEventContent?
        var processSteps: [ProcessStep] = []
    }

    /// Convert a `TaskEvent` into a `DisplayRow` with all fields populated
    /// for rendering in the transcript.
    static func project(_ event: TaskEvent) -> DisplayRow {
        let seq = event.seq
        let date = Date(timeIntervalSince1970: Double(event.ts) / 1000.0)

        switch event.content {
        case .message(_, let text, let speaker, _):
            return messageRow(
                seq: seq,
                date: date,
                speaker: speaker,
                text: text,
                content: event.content
            )

        case .reasoning(let text):
            return DisplayRow(
                id: "\(seq)-reasoning",
                seq: seq,
                timestamp: date,
                icon: "brain.head.profile",
                iconColor: .orange,
                primaryText: text,
                secondaryText: nil,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: true,
                rawContent: event.content
            )

        case .toolCall(let name, let summary, _, _):
            return DisplayRow(
                id: "\(seq)-toolcall",
                seq: seq,
                timestamp: date,
                icon: "wrench.and.screwdriver.fill",
                iconColor: .blue,
                primaryText: name,
                secondaryText: summary,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: true,
                rawContent: event.content
            )

        case .error(let message):
            return DisplayRow(
                id: "\(seq)-error",
                seq: seq,
                timestamp: date,
                icon: "exclamationmark.triangle.fill",
                iconColor: .red,
                primaryText: message,
                secondaryText: nil,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .approval(_, let summary):
            return DisplayRow(
                id: "\(seq)-approval",
                seq: seq,
                timestamp: date,
                icon: "checkmark.shield.fill",
                iconColor: .green,
                primaryText: String(localized: "event.approval_request"),
                secondaryText: summary,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .question(_, let summary):
            return DisplayRow(
                id: "\(seq)-question",
                seq: seq,
                timestamp: date,
                icon: "questionmark.bubble.fill",
                iconColor: .teal,
                primaryText: String(localized: "event.question"),
                secondaryText: summary,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .statusChange(let from, let to):
            return DisplayRow(
                id: "\(seq)-statuschange",
                seq: seq,
                timestamp: date,
                icon: "arrow.triangle.swap",
                iconColor: .gray,
                primaryText: String(
                    format: String(localized: "event.status_change_format"),
                    from,
                    to
                ),
                secondaryText: nil,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .unknown:
            return DisplayRow(
                id: "\(seq)-unknown",
                seq: seq,
                timestamp: date,
                icon: "questionmark",
                iconColor: .secondary,
                primaryText: String(localized: "event.unknown"),
                secondaryText: nil,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case nil:
            return DisplayRow(
                id: "\(seq)-nil",
                seq: seq,
                timestamp: date,
                icon: "questionmark",
                iconColor: .secondary,
                primaryText: String(localized: "event.empty"),
                secondaryText: nil,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: nil
            )
        }
    }

    /// Event types the transcript never shows. They carry accounting, cost, or
    /// lifecycle detail that the console keeps out of the chat log, and they land
    /// in the middle of a streaming run — `usage` and `raw_output` arrive between
    /// a turn's last chunk and its summary — so rendering them would both add
    /// placeholder rows and split the answer apart.
    private static let unrenderedEventTypes: Set<String> = [
        "usage",
        "raw_output",
        "task_started",
        "result",
        "approval_decided",
        "checkpoint_skipped",
        "orchestration_fallback",
        "limit_hit",
        "meta",
    ]

    /// Project a whole event list into the rows the transcript shows.
    ///
    /// The daemon stores a turn's live output as a run of `partial` message
    /// events followed by one non-partial message holding the complete text, so a
    /// row per event shows every chunk as its own bubble and then the whole answer
    /// again. Chunks are accumulated here and dropped when the message that
    /// supersedes them arrives, matching the console's transcript projection.
    static func rows(from events: [TaskEvent]) -> [DisplayRow] {
        var rows: [DisplayRow] = []
        /// The message being accumulated, keyed by the seq and timestamp that
        /// opened it so the live row keeps a stable identity while it grows.
        var stream: (seq: Int, ts: Int, role: String, speaker: String, text: String)?
        /// Chunks already shown for the current turn. A preview only stands until
        /// the message that supersedes it arrives, which then removes it: a turn
        /// that streams, does tool work, streams again, and ends with one complete
        /// message streams the same answer twice over.
        var previews: [(id: String, speaker: String)] = []
        var process: (seq: Int, ts: Int, steps: [ProcessStep])?
        var processStepIndexes: [String: Int] = [:]

        func flushStream() {
            guard let pending = stream else { return }
            stream = nil
            guard !isBlank(pending.text) else { return }
            // A run with no final message yet is the live answer: show what has
            // arrived so far rather than holding it back until the turn ends.
            let row = messageRow(
                seq: pending.seq,
                date: Date(timeIntervalSince1970: Double(pending.ts) / 1000.0),
                speaker: pending.speaker,
                text: pending.text
            )
            rows.append(row)
            previews.append((row.id, pending.speaker))
        }

        func appendProcessStep(_ step: ProcessStep, from event: TaskEvent) {
            if process == nil {
                process = (seq: event.seq, ts: event.ts, steps: [])
                processStepIndexes = [:]
            }

            guard var current = process else { return }
            if let index = processStepIndexes[step.id], index < current.steps.count {
                let existing = current.steps[index]
                if step.kind == .note, existing.status == .running, step.status == .running {
                    current.steps[index] = ProcessStep(
                        id: step.id,
                        kind: step.kind,
                        label: step.label,
                        detail: existing.detail + step.detail,
                        expandedDetail: (existing.expandedDetail ?? existing.detail) + (step.expandedDetail ?? step.detail),
                        status: step.status
                    )
                } else {
                    current.steps[index] = step
                }
            } else {
                processStepIndexes[step.id] = current.steps.count
                current.steps.append(step)
            }
            process = current
        }

        func settledSteps(_ steps: [ProcessStep], as status: ProcessStep.Status) -> [ProcessStep] {
            steps.map { step in
                guard step.status == .running else { return step }
                return ProcessStep(
                    id: step.id,
                    kind: step.kind,
                    label: step.label,
                    detail: step.detail,
                    expandedDetail: step.expandedDetail,
                    status: status
                )
            }
        }

        func makeProcessRow(seq: Int, ts: Int, steps: [ProcessStep]) -> DisplayRow {
            DisplayRow(
                id: "\(seq)-process",
                seq: seq,
                timestamp: Date(timeIntervalSince1970: Double(ts) / 1000.0),
                icon: processIcon(for: steps),
                iconColor: processColor(for: steps),
                primaryText: processSummary(for: steps),
                secondaryText: latestProcessDetail(in: steps),
                style: .process,
                speaker: nil,
                level: nil,
                isCollapsible: true,
                rawContent: nil,
                processSteps: steps
            )
        }

        func settleProcessSteps(as status: ProcessStep.Status) {
            guard var current = process else { return }
            current.steps = settledSteps(current.steps, as: status)
            process = current
        }

        func settleProcessRows(as status: ProcessStep.Status) {
            for index in rows.indices where rows[index].style == .process {
                let settled = settledSteps(rows[index].processSteps, as: status)
                guard settled != rows[index].processSteps else { continue }
                rows[index] = makeProcessRow(seq: rows[index].seq, ts: Int(rows[index].timestamp.timeIntervalSince1970 * 1000), steps: settled)
            }
        }

        func flushProcess() {
            guard let current = process, !current.steps.isEmpty else { return }
            let steps = current.steps
            process = nil
            processStepIndexes = [:]

            rows.append(makeProcessRow(seq: current.seq, ts: current.ts, steps: steps))
        }

        for event in events {
            if event.eventType == "result" {
                let status: ProcessStep.Status = payloadBool(event, "is_error") ? .error : .done
                flushStream()
                settleProcessSteps(as: status)
                settleProcessRows(as: status)
                flushProcess()
                continue
            }
            guard !unrenderedEventTypes.contains(event.eventType) else { continue }
            if let step = processStep(for: event) {
                flushStream()
                appendProcessStep(step, from: event)
                continue
            }
            switch event.content {
            case let .message(role, text, speaker, partial) where partial:
                if let openedBy = stream, openedBy.speaker != speaker || openedBy.role != role {
                    flushStream()
                }
                if stream == nil {
                    flushProcess()
                }
                let openedBy = stream
                stream = (
                    seq: openedBy?.seq ?? event.seq,
                    ts: openedBy?.ts ?? event.ts,
                    role: role,
                    speaker: speaker,
                    text: (openedBy?.text ?? "") + text
                )

            case let .message(role, text, speaker, _):
                // The non-partial message is the authoritative copy of the run it
                // closes. Drop the accumulated preview instead of flushing it, and
                // take back what this speaker already streamed in this turn, which
                // would otherwise repeat the same text.
                if let openedBy = stream, openedBy.speaker == speaker, openedBy.role == role {
                    stream = nil
                } else {
                    flushStream()
                }
                if speaker == "user" {
                    // A new user turn ends the run; older previews stand.
                    previews.removeAll()
                } else {
                    // The console also takes back previews across tool work, but
                    // stops at notices such as approvals, which it shows in a
                    // progress card that keeps the earlier text. The transcript has
                    // no such card, so here a notice does not end the run: text
                    // streamed before it belongs to the same answer.
                    let superseded = Set(
                        previews.lazy.filter { $0.speaker == speaker }.map(\.id)
                    )
                    if !superseded.isEmpty {
                        rows.removeAll { superseded.contains($0.id) }
                        previews.removeAll { superseded.contains($0.id) }
                    }
                }
                flushProcess()
                // Empty messages are echoes of tool output the daemon stamps with
                // a role but no text; they are not transcript lines.
                guard !isBlank(text) else { continue }
                rows.append(project(event))

            default:
                flushStream()
                flushProcess()
                guard let row = visibleNoticeRow(for: event) else { continue }
                rows.append(row)
                // Failures end the run, so nothing later supersedes its previews.
                if event.eventType == "error" { previews.removeAll() }
            }
        }
        flushStream()
        flushProcess()
        return rows
    }

    /// Whether a message carries nothing to show.
    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func visibleNoticeRow(for event: TaskEvent) -> DisplayRow? {
        if event.eventType.hasPrefix("workspace_") {
            guard let label = workspaceEventLabel(for: event) else { return nil }
            let date = Date(timeIntervalSince1970: Double(event.ts) / 1000.0)
            return DisplayRow(
                id: "\(event.seq)-workspace",
                seq: event.seq,
                timestamp: date,
                icon: "shippingbox.fill",
                iconColor: .indigo,
                primaryText: label,
                secondaryText: nil,
                style: .notice,
                speaker: nil,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )
        }

        switch event.content {
        case .error, .approval, .question, .statusChange:
            return project(event)
        default:
            return nil
        }
    }

    private static func processStep(for event: TaskEvent) -> ProcessStep? {
        switch event.content {
        case .reasoning(let text):
            return noteStep(id: "note-\(event.seq)", text: text, status: .done)
        case .toolCall(let name, let summary, _, _):
            return toolStep(id: "tool-\(event.seq)", name: name, detail: summary, output: nil, status: .done)
        case .message(_, let text, let speaker, _):
            guard !isBlank(text), speaker != "user", isProgressMessage(event) else { return nil }
            let status: ProcessStep.Status = payloadBool(event, "partial") ? .running : .done
            return noteStep(id: messageKey(for: event), text: text, status: status)
        default:
            break
        }

        switch event.eventType {
        case "tool_use":
            let name = payloadString(event, "name")
                ?? payloadString(event, "tool_name")
                ?? payloadString(event, "type")
                ?? "tool"
            let id = payloadString(event, "tool_use_id")
                ?? payloadString(event, "id")
                ?? "seq-\(event.seq)"
            let detail = payloadString(event, "summary")
                ?? payloadString(event, "description")
                ?? name
            return toolStep(id: id, name: name, detail: detail, output: nil, status: .running)
        case "tool_result":
            let id = payloadString(event, "tool_use_id")
                ?? payloadString(event, "id")
                ?? "seq-\(event.seq)"
            let name = payloadString(event, "name")
                ?? payloadString(event, "tool_name")
                ?? "tool"
            let ok = payloadBoolValue(event, "ok")
                ?? (!payloadBool(event, "is_error") && payloadString(event, "status") != "error")
            let detail = payloadString(event, "summary")
                ?? payloadString(event, "description")
                ?? payloadString(event, "output")
                ?? name
            return toolStep(
                id: id,
                name: name,
                detail: detail,
                output: payloadString(event, "output"),
                status: ok ? .done : .error
            )
        default:
            return nil
        }
    }

    private static func noteStep(id: String, text: String, status: ProcessStep.Status) -> ProcessStep {
        ProcessStep(
            id: id,
            kind: .note,
            label: String(localized: "event.process.note", defaultValue: "Note"),
            detail: text.trimmingCharacters(in: .whitespacesAndNewlines),
            expandedDetail: text,
            status: status
        )
    }

    private static func toolStep(
        id: String,
        name: String,
        detail: String,
        output: String?,
        status: ProcessStep.Status
    ) -> ProcessStep {
        ProcessStep(
            id: id,
            kind: .tool,
            label: prettyToolName(name),
            detail: detail.trimmingCharacters(in: .whitespacesAndNewlines),
            expandedDetail: output,
            status: status
        )
    }

    private static func isProgressMessage(_ event: TaskEvent) -> Bool {
        if visibilityUser(event) == false { return true }
        let phase = payloadString(event, "phase")
        if phase == "summary" { return false }
        if phase == "plan" || phase == "progress" { return true }
        if payloadString(event, "role") == "reasoning" { return true }
        let source = payloadString(event, "source")
        if source == "delegate" { return true }
        if source == "orchestrator" {
            return !isLegacyOrchestratorSummaryWording(payloadText(event))
        }
        return false
    }

    private static func messageKey(for event: TaskEvent) -> String {
        if let messageID = payloadString(event, "message_id") {
            let index = payloadString(event, "index") ?? ""
            return index.isEmpty ? "note-\(messageID)" : "note-\(messageID)-\(index)"
        }
        return "note-\(event.seq)"
    }

    private static func payloadObject(_ event: TaskEvent) -> [String: Any] {
        guard let data = event.payloadData else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private static func payloadString(_ event: TaskEvent, _ key: String) -> String? {
        let value = payloadObject(event)[key]
        if let text = value as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let number = value as? NSNumber {
            return number.stringValue
        }
        return nil
    }

    private static func payloadBool(_ event: TaskEvent, _ key: String) -> Bool {
        payloadBoolValue(event, key) ?? false
    }

    private static func payloadBoolValue(_ event: TaskEvent, _ key: String) -> Bool? {
        let value = payloadObject(event)[key]
        if let bool = value as? Bool { return bool }
        if let string = value as? String {
            return string == "true" || string == "1"
        }
        if let number = value as? NSNumber {
            return number.boolValue
        }
        return nil
    }

    private static func payloadText(_ event: TaskEvent) -> String {
        switch event.content {
        case .message(_, let text, _, _):
            return text
        default:
            return payloadString(event, "text") ?? payloadString(event, "content") ?? ""
        }
    }

    private static func visibilityUser(_ event: TaskEvent) -> Bool? {
        guard let visibility = payloadObject(event)["visibility"] as? [String: Any],
              let user = visibility["user"]
        else { return nil }
        if let bool = user as? Bool { return bool }
        if let string = user as? String { return string == "true" || string == "1" }
        if let number = user as? NSNumber { return number.boolValue }
        return nil
    }

    private static func processSummary(for steps: [ProcessStep]) -> String {
        if steps.contains(where: { $0.status == .running }) {
            return "\(String(localized: "event.process.running", defaultValue: "Running")) · \(processActivity(for: steps))"
        }
        if steps.contains(where: { $0.status == .error }) {
            return "\(String(localized: "event.process.failed", defaultValue: "Failed")) · \(processActivity(for: steps))"
        }
        return "\(String(localized: "event.process.done", defaultValue: "Done")) · \(processActivity(for: steps))"
    }

    private static func processActivity(for steps: [ProcessStep]) -> String {
        var counts: [String: Int] = [:]
        for step in steps where step.kind == .tool {
            counts[step.label, default: 0] += 1
        }
        if !counts.isEmpty {
            return counts.keys.sorted().map { "\($0) × \(counts[$0] ?? 0)" }.joined(separator: " · ")
        }
        return String(
            format: String(localized: "event.process.notes_format", defaultValue: "%lld note(s)"),
            steps.count
        )
    }

    private static func latestProcessDetail(in steps: [ProcessStep]) -> String? {
        steps.last(where: { !$0.detail.isEmpty })?.detail
    }

    private static func processIcon(for steps: [ProcessStep]) -> String {
        steps.contains(where: { $0.status == .running }) ? "arrow.triangle.2.circlepath" : "checkmark.circle"
    }

    private static func processColor(for steps: [ProcessStep]) -> Color {
        if steps.contains(where: { $0.status == .running }) { return .blue }
        if steps.contains(where: { $0.status == .error }) { return .red }
        return .green
    }

    private static func prettyToolName(_ name: String) -> String {
        switch name {
        case "bash":
            return String(localized: "event.process.tool.shell", defaultValue: "Shell")
        case "read_file":
            return String(localized: "event.process.tool.read", defaultValue: "Read")
        case "write_file":
            return String(localized: "event.process.tool.write", defaultValue: "Write")
        case "edit_file":
            return String(localized: "event.process.tool.edit", defaultValue: "Edit")
        case "list_dir":
            return String(localized: "event.process.tool.list", defaultValue: "List")
        case "glob":
            return String(localized: "event.process.tool.glob", defaultValue: "Glob")
        default:
            return name.isEmpty ? String(localized: "event.process.tool.generic", defaultValue: "Tool") : name
        }
    }

    private static func workspaceEventLabel(for event: TaskEvent) -> String? {
        let base: String
        switch event.eventType {
        case "workspace_provisioning":
            base = String(localized: "workspace.generation.eventProvisioning", defaultValue: "Workspace provisioning")
        case "workspace_ready":
            base = String(localized: "workspace.generation.eventReady", defaultValue: "Workspace ready")
        case "workspace_active":
            base = String(localized: "workspace.generation.eventActive", defaultValue: "Workspace active")
        case "workspace_finalizing":
            base = String(localized: "workspace.generation.eventFinalizing", defaultValue: "Finalizing workspace")
        case "workspace_integrated":
            base = String(localized: "workspace.generation.eventIntegrated", defaultValue: "Workspace merged")
        case "workspace_released":
            base = String(localized: "workspace.generation.eventReleased", defaultValue: "Workspace released")
        case "workspace_merge_blocked":
            base = String(localized: "workspace.generation.eventMergeBlocked", defaultValue: "Merge blocked")
        case "workspace_finalize_blocked":
            base = String(localized: "workspace.generation.eventFinalizeBlocked", defaultValue: "Finalize blocked")
        case "workspace_orphaned":
            base = String(localized: "workspace.generation.eventOrphaned", defaultValue: "Workspace orphaned")
        case "workspace_legacy_pending":
            base = String(localized: "workspace.generation.eventLegacyPending", defaultValue: "Legacy workspace")
        default:
            return nil
        }

        let generation = payloadString(event, "generation").map { " #\($0)" } ?? ""
        let id = payloadString(event, "workspace_id").map { " (\(String($0.prefix(8))))" } ?? ""
        return "\(base)\(generation)\(id)"
    }

    private static func isLegacyOrchestratorSummaryWording(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.range(of: #"^完成(（有失败）)?[：:]"#, options: .regularExpression) != nil {
            return true
        }
        return trimmed.range(of: #"^(done|completed)([:：]|\s*\()"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Row for a message. A run of chunks that is still streaming renders under
    /// the seq that opened it; the message that completes the run replaces it.
    ///
    /// The speaker decides the column, not the role: a tool-result echo or a
    /// skill preamble carries `role: "user"` while naming the agent that
    /// produced it, and the console gives those to the agent column too.
    private static func messageRow(
        seq: Int,
        date: Date,
        speaker: String,
        text: String,
        content: TaskEventContent? = nil
    ) -> DisplayRow {
        let isUser = speaker == "user"
        return DisplayRow(
            id: "\(seq)-message",
            seq: seq,
            timestamp: date,
            icon: isUser ? "person.fill" : "brain",
            iconColor: isUser ? .accentColor : .purple,
            // An attachment block carries absolute local paths for the agent; the
            // reader gets the file names instead. The console's transcript does
            // the same to the user's own turns.
            primaryText: isUser ? TaskPresentation.displayUserPrompt(text) : text,
            secondaryText: nil,
            style: isUser ? .user : .agent,
            speaker: speaker,
            level: nil,
            isCollapsible: false,
            rawContent: content
        )
    }

    /// Format a `Date` as a short time string for the transcript.
    static func formatTimestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    /// Format `elapsedSeconds` as a human-readable duration string.
    static func formatElapsed(_ seconds: Double?) -> String {
        TaskPresentation.formatElapsed(seconds)
    }

    /// Format `costCents` (in hundredths of a cent) as a display string.
    static func formatCost(_ cents: Double?) -> String {
        guard let cents else { return "—" }
        return TaskPresentation.formatCostUSD(cents / 100.0)
    }
}
