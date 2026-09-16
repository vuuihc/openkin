import SwiftUI

struct RoutinesView: View {
    @Environment(AppSession.self) private var appSession
    @State private var routines: [Routine] = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var showingNewRoutine = false

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red)
            }

            if routines.isEmpty && !isLoading && error == nil {
                ContentUnavailableView(
                    "No routines",
                    systemImage: "clock.arrow.circlepath",
                    description: Text("Create recurring agent work from your phone.")
                )
            }

            ForEach(routines) { routine in
                RoutineRow(
                    routine: routine,
                    canManage: appSession.canManageDaemon,
                    onToggle: { enabled in await toggle(routine, enabled: enabled) },
                    onRun: { await run(routine) },
                    onDelete: { await delete(routine) }
                )
            }
            .onDelete { offsets in
                guard appSession.canManageDaemon else { return }
                let selected = offsets.map { routines[$0] }
                Task {
                    for routine in selected {
                        await delete(routine)
                    }
                }
            }
        }
        .navigationTitle("Routines")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if appSession.canManageDaemon {
                    Button {
                        showingNewRoutine = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New routine")
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $showingNewRoutine) {
            RoutineEditorView { await load() }
        }
    }

    private func load() async {
        guard let client = appSession.apiClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            routines = try await client.routines()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ routine: Routine, enabled: Bool) async {
        guard let client = appSession.apiClient else { return }
        do {
            let updated = try await client.updateRoutine(
                id: routine.id,
                body: RoutinePatchBody(
                    title: nil, projectId: nil, cwd: nil, agent: nil,
                    permissionMode: nil, prompt: nil, intervalSecs: nil,
                    enabled: enabled
                )
            )
            if let index = routines.firstIndex(where: { $0.id == updated.id }) {
                routines[index] = updated
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func run(_ routine: Routine) async {
        guard let client = appSession.apiClient else { return }
        do {
            _ = try await client.runRoutineNow(id: routine.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ routine: Routine) async {
        guard let client = appSession.apiClient else { return }
        do {
            try await client.deleteRoutine(id: routine.id)
            routines.removeAll { $0.id == routine.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct RoutineRow: View {
    let routine: Routine
    let canManage: Bool
    let onToggle: (Bool) async -> Void
    let onRun: () async -> Void
    let onDelete: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(routine.title)
                    .font(.headline)
                Spacer()
                if canManage {
                    Toggle("", isOn: Binding(
                        get: { routine.enabled },
                        set: { enabled in Task { await onToggle(enabled) } }
                    ))
                    .labelsHidden()
                }
            }
            Text(routine.prompt)
                .lineLimit(2)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack {
                Label(routine.agent, systemImage: "cpu")
                Spacer()
                Text(intervalText(routine.intervalSecs))
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
            if canManage {
                HStack {
                    Button("Run now") { Task { await onRun() } }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button("Delete", role: .destructive) { Task { await onDelete() } }
                        .buttonStyle(.borderless)
                }
            }
        }
        .padding(.vertical, 5)
    }

    private func intervalText(_ seconds: Int) -> String {
        if seconds >= 86_400 { return "Every \(seconds / 86_400)d" }
        if seconds >= 3_600 { return "Every \(seconds / 3_600)h" }
        return "Every \(max(1, seconds / 60))m"
    }
}

private struct RoutineEditorView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let onSaved: () async -> Void

    @State private var title = ""
    @State private var prompt = ""
    @State private var cwd = ""
    @State private var agent = "claude-code"
    @State private var intervalMinutes = 60
    @State private var isSaving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("Working directory", text: $cwd)
                TextField("Agent", text: $agent)
                Stepper("Every \(intervalMinutes) minutes", value: $intervalMinutes, in: 5...10_080, step: 5)
                Section("Prompt") {
                    TextEditor(text: $prompt).frame(minHeight: 140)
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Spacer()
                        if isSaving { ProgressView() } else { Text("Create Routine") }
                        Spacer()
                    }
                }
                .disabled(isSaving || title.isEmpty || prompt.isEmpty || cwd.isEmpty)
            }
            .navigationTitle("New Routine")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func save() async {
        guard let client = appSession.apiClient else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createRoutine(
                body: RoutineWriteBody(
                    title: title, projectId: nil, cwd: cwd, agent: agent,
                    permissionMode: "default", prompt: prompt,
                    intervalSecs: intervalMinutes * 60, enabled: true
                )
            )
            await onSaved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
