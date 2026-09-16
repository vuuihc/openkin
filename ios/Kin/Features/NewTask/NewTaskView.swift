import SwiftUI

/// Sheet for creating a new Kin task.
struct NewTaskView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = NewTaskViewModel()

    var body: some View {
        NavigationStack {
            Form {
                agentSection
                modelSection
                cwdSection
                promptSection
                permissionSection
                submitSection
            }
            .navigationTitle(String(localized: "task.new"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "action.cancel")) { dismiss() }
                }
            }
            .alert(
                String(localized: "permission.yolo.confirm.title"),
                isPresented: $viewModel.showUnrestrictedAlert
            ) {
                Button(String(localized: "action.cancel"), role: .cancel) { }
                Button(String(localized: "permission.yolo.confirm.action"), role: .destructive) {
                    viewModel.confirmedUnrestricted = true
                    submit()
                }
            } message: {
                Text(String(localized: "permission.yolo.confirm.body"))
            }
            .alert(
                String(localized: "common.error"),
                isPresented: .init(
                    get: { viewModel.error != nil },
                    set: { if !$0 { viewModel.error = nil } }
                )
            ) {
                Button(String(localized: "common.ok")) { viewModel.error = nil }
            } message: {
                Text(viewModel.error ?? "")
            }
            .task {
                if let client = appSession.apiClient {
                    viewModel.configure(apiClient: client)
                }
                await viewModel.load()
            }
            .disabled(viewModel.isSubmitting)
        }
    }

    // MARK: - Sections

    private var agentSection: some View {
        Section(String(localized: "task.agent")) {
            Picker(String(localized: "task.agent"), selection: $viewModel.selectedAgent) {
                ForEach(viewModel.agents) { agent in
                    Text(agent.name).tag(agent as Agent?)
                }
            }
            .pickerStyle(.menu)
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        if let models = viewModel.selectedAgentModels {
            Section(String(localized: "task.model")) {
                Picker(String(localized: "task.model"), selection: $viewModel.selectedModel) {
                    Text(String(localized: "task.model.default")).tag(nil as String?)
                    ForEach(models, id: \.self) { model in
                        Text(model).tag(model as String?)
                    }
                }
                .pickerStyle(.menu)
            }
        }
    }

    private var cwdSection: some View {
        Section(String(localized: "task.directory")) {
            Picker(String(localized: "task.directory"), selection: $viewModel.selectedCWD) {
                ForEach(viewModel.recentCwds, id: \.self) { cwd in
                    Text(cwd).tag(cwd as String?)
                }
                Text(String(localized: "task.directory.manual")).tag(nil as String?)
            }
            .pickerStyle(.menu)

            if viewModel.selectedCWD == nil {
                TextField(String(localized: "task.directory.hint"), text: $viewModel.customCWD)
            }
        }
    }

    private var promptSection: some View {
        Section(String(localized: "task.prompt")) {
            TextEditor(text: $viewModel.prompt)
                .frame(minHeight: 100)
                .overlay(alignment: .topLeading) {
                    if viewModel.prompt.isEmpty {
                        Text(String(localized: "task.prompt"))
                            .foregroundColor(.secondary)
                            .padding(.top, 8)
                            .padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                }
        }
    }

    private var permissionSection: some View {
        Section(String(localized: "task.permission")) {
            Picker(String(localized: "task.permission"), selection: $viewModel.permissionMode) {
                Text(String(localized: "permission.default")).tag("default")
                Text(String(localized: "permission.accept_edits")).tag("accept_edits")
                Text(String(localized: "permission.yolo")).tag("unrestricted")
            }
            .pickerStyle(.menu)
        }
    }

    private var submitSection: some View {
        Section {
            Button(action: submit) {
                HStack {
                    Spacer()
                    if viewModel.isSubmitting {
                        ProgressView()
                    } else {
                        Text(String(localized: "task.start"))
                    }
                    Spacer()
                }
            }
            .disabled(
                viewModel.prompt.trimmingCharacters(in: .whitespaces).isEmpty
                || viewModel.isSubmitting
            )
        }
    }

    // MARK: - Actions

    @MainActor
    private func submit() {
        guard !viewModel.prompt.trimmingCharacters(in: .whitespaces).isEmpty else { return }

        if viewModel.permissionMode == "unrestricted" && !viewModel.confirmedUnrestricted {
            viewModel.showUnrestrictedAlert = true
            return
        }

        Task {
            if await viewModel.submit() != nil {
                dismiss()
            }
        }
    }
}

#Preview {
    NewTaskView()
}
