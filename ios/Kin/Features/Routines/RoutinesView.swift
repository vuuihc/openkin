import SwiftUI

struct RoutinesView: View {
    @Environment(AppSession.self) private var appSession
    @State private var routines: [Routine] = []
    @State private var isLoading = false
    @State private var loadedProfileID: UUID?
    @State private var error: String?
    @State private var showingNewRoutine = false
    @State private var newRoutineProfileID: UUID?

    var body: some View {
        List {
            OperationsScopeSection(profile: appSession.activeProfile, connectionState: appSession.connectionState)

            if let error {
                Text(error).foregroundStyle(.red)
            }

            if routines.isEmpty && !isLoading && error == nil {
                ContentUnavailableView(
                    String(localized: "routines.empty.title"),
                    systemImage: "clock.arrow.circlepath",
                    description: Text(String(localized: "routines.empty.message"))
                )
            }

            ForEach(routines) { routine in
                RoutineRow(
                    routine: routine,
                    canManage: canMutateLoadedProfile,
                    onToggle: { enabled in await toggle(routine, enabled: enabled) },
                    onRun: { await run(routine) },
                    onDelete: { await delete(routine) }
                )
                .deleteDisabled(!canMutateLoadedProfile)
            }
            .onDelete { offsets in
                guard canMutateLoadedProfile else { return }
                let selected = offsets.map { routines[$0] }
                Task {
                    for routine in selected {
                        await delete(routine)
                    }
                }
            }
        }
        .navigationTitle(String(localized: "settings.routines"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if canMutateLoadedProfile {
                    Button {
                        newRoutineProfileID = appSession.activeProfileID
                        showingNewRoutine = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(String(localized: "routines.new"))
                }
            }
        }
        .refreshable { await load() }
        .task(id: appSession.activeProfileID) { await load() }
        .sheet(isPresented: $showingNewRoutine, onDismiss: { newRoutineProfileID = nil }) {
            RoutineEditorView(boundProfileID: newRoutineProfileID) { await load() }
        }
    }

    private var canMutateLoadedProfile: Bool {
        OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: loadedProfileID,
            activeProfileID: appSession.activeProfileID,
            canManageDaemon: appSession.canManageDaemon
        )
    }

    private func load() async {
        guard let requestedProfileID = appSession.activeProfileID, let client = appSession.apiClient else {
            routines = []
            loadedProfileID = appSession.activeProfileID
            isLoading = false
            error = nil
            return
        }
        if loadedProfileID != requestedProfileID {
            routines = []
        }
        isLoading = true
        do {
            let loaded = try await client.routines()
            guard appSession.activeProfileID == requestedProfileID else { return }
            routines = loaded
            loadedProfileID = requestedProfileID
            isLoading = false
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            routines = []
            loadedProfileID = requestedProfileID
            isLoading = false
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ routine: Routine, enabled: Bool) async {
        guard let requestedProfileID = appSession.activeProfileID,
              loadedProfileID == requestedProfileID,
              let client = appSession.apiClient,
              appSession.canManageDaemon else { return }
        do {
            let updated = try await client.updateRoutine(
                id: routine.id,
                body: RoutinePatchBody(
                    title: nil, projectId: nil, cwd: nil, agent: nil,
                    permissionMode: nil, prompt: nil, intervalSecs: nil,
                    enabled: enabled
                )
            )
            guard appSession.activeProfileID == requestedProfileID else { return }
            if let index = routines.firstIndex(where: { $0.id == updated.id }) {
                routines[index] = updated
            }
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }

    private func run(_ routine: Routine) async {
        guard let requestedProfileID = appSession.activeProfileID,
              loadedProfileID == requestedProfileID,
              let client = appSession.apiClient,
              appSession.canManageDaemon else { return }
        do {
            _ = try await client.runRoutineNow(id: routine.id)
            guard appSession.activeProfileID == requestedProfileID else { return }
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }

    private func delete(_ routine: Routine) async {
        guard let requestedProfileID = appSession.activeProfileID,
              loadedProfileID == requestedProfileID,
              let client = appSession.apiClient,
              appSession.canManageDaemon else { return }
        do {
            try await client.deleteRoutine(id: routine.id)
            guard appSession.activeProfileID == requestedProfileID else { return }
            routines.removeAll { $0.id == routine.id }
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
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
                    Button(String(localized: "routines.run_now")) { Task { await onRun() } }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button(String(localized: "action.delete"), role: .destructive) { Task { await onDelete() } }
                        .buttonStyle(.borderless)
                }
            } else {
                Text(String(localized: "routines.read_only.message"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 5)
    }

    private func intervalText(_ seconds: Int) -> String {
        if seconds >= 86_400 {
            return String(
                format: String(localized: "routines.interval.days_format"),
                seconds / 86_400
            )
        }
        if seconds >= 3_600 {
            return String(
                format: String(localized: "routines.interval.hours_format"),
                seconds / 3_600
            )
        }
        return String(
            format: String(localized: "routines.interval.minutes_format"),
            max(1, seconds / 60)
        )
    }
}

private struct RoutineEditorView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let boundProfileID: UUID?
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
                OperationsScopeSection(profile: appSession.activeProfile, connectionState: appSession.connectionState)
                TextField(String(localized: "routines.title"), text: $title)
                TextField(String(localized: "routines.cwd"), text: $cwd)
                TextField(String(localized: "routines.agent"), text: $agent)
                Stepper(
                    String(
                        format: String(localized: "routines.every_minutes_format"),
                        intervalMinutes
                    ),
                    value: $intervalMinutes,
                    in: 5...10_080,
                    step: 5
                )
                Section(String(localized: "routines.prompt")) {
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
                        if isSaving {
                            ProgressView()
                        } else {
                            Text(String(localized: "routines.create"))
                        }
                        Spacer()
                    }
                }
                .disabled(
                    isSaving
                        || !canEditCurrentProfile
                        || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
            .navigationTitle(String(localized: "routines.new"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "action.cancel")) { dismiss() }
                }
            }
            .onChange(of: appSession.activeProfileID) { _, activeProfileID in
                if boundProfileID != activeProfileID {
                    dismiss()
                }
            }
        }
    }

    private var canEditCurrentProfile: Bool {
        OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: boundProfileID,
            activeProfileID: appSession.activeProfileID,
            canManageDaemon: appSession.canManageDaemon
        )
    }

    private func save() async {
        guard let requestedProfileID = appSession.activeProfileID,
              boundProfileID == requestedProfileID,
              let client = appSession.apiClient,
              appSession.canManageDaemon else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createRoutine(
                body: RoutineWriteBody(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    projectId: nil,
                    cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines),
                    agent: agent.trimmingCharacters(in: .whitespacesAndNewlines),
                    permissionMode: "default",
                    prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    intervalSecs: intervalMinutes * 60, enabled: true
                )
            )
            guard appSession.activeProfileID == requestedProfileID else { return }
            await onSaved()
            dismiss()
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }
}
