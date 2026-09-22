import SwiftUI

/// Sheet for creating a new Kin task.
struct NewTaskView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = NewTaskViewModel()
    @State private var submitTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    targetCard
                    promptComposer
                    configurationPanel
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 96)
            }
            .background(Color(.systemGroupedBackground))
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(String(localized: "task.create"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "action.cancel")) { dismiss() }
                }
            }
            .alert(
                String(localized: "permission.unrestricted.confirm.title"),
                isPresented: $viewModel.showUnrestrictedAlert
            ) {
                Button(String(localized: "action.cancel"), role: .cancel) { }
                Button(String(localized: "permission.unrestricted.confirm.action"), role: .destructive) {
                    viewModel.confirmedUnrestricted = true
                    submit()
                }
            } message: {
                Text(String(localized: "permission.unrestricted.confirm.body"))
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
                await bindAndLoad()
            }
            .onChange(of: viewModel.selectedAgent) { _, selectedAgent in
                viewModel.selectAgent(selectedAgent)
            }
            .onChange(of: appSession.activeProfileID) { _, _ in
                submitTask?.cancel()
                submitTask = nil
                viewModel.invalidateActiveProfileChange()
            }
            .onDisappear {
                submitTask?.cancel()
                submitTask = nil
            }
            .safeAreaInset(edge: .bottom) {
                submitBar
            }
        }
    }

    // MARK: - Content

    private var targetCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isCurrentProfileContext ? "desktopcomputer" : "exclamationmark.triangle.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(isCurrentProfileContext ? Color.accentColor : .orange)
                    .frame(width: 36, height: 36)
                    .background((isCurrentProfileContext ? Color.accentColor : Color.orange).opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: "task.new.target.title"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(activeDesktopName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(targetMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
            }

            Label(connectionStateText, systemImage: connectionStateIcon)
                .font(.caption.weight(.medium))
                .foregroundStyle(connectionStateColor)

            if viewModel.boundProfileID != nil && !isCurrentProfileContext {
                Divider()
                Text(String(localized: "task.new.stale.message"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    dismiss()
                } label: {
                    Label(String(localized: "task.detail.return_to_work"), systemImage: "arrow.backward")
                }
                .font(.subheadline.weight(.semibold))
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(.separator).opacity(0.2), lineWidth: 0.5)
        )
    }

    private var promptComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(String(localized: "task.new.prompt.title"))
                .font(.headline)

            TextEditor(text: $viewModel.prompt)
                .frame(minHeight: 190)
                .padding(8)
                .background(Color(.tertiarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color(.separator).opacity(0.22), lineWidth: 0.5)
                )
                .overlay(alignment: .topLeading) {
                    if viewModel.prompt.isEmpty {
                        Text(String(localized: "task.new.prompt.placeholder"))
                            .foregroundStyle(.secondary)
                            .padding(.top, 16)
                            .padding(.leading, 13)
                            .allowsHitTesting(false)
                    }
                }
                .disabled(viewModel.isSubmitting || !isCurrentProfileContext)
                .accessibilityLabel(String(localized: "task.new.prompt.title"))
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var configurationPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(String(localized: "task.new.configure.title"))
                    .font(.headline)
                Text(String(localized: "task.new.configure.subtitle"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 10),
                    GridItem(.flexible(), spacing: 10)
                ],
                spacing: 10
            ) {
                configMenu(
                    title: String(localized: "task.new.config.agent"),
                    value: selectedAgentLabel,
                    systemImage: "cpu",
                    isEnabled: !viewModel.agents.isEmpty && isCurrentProfileContext
                ) {
                    if viewModel.agents.isEmpty {
                        Text(String(localized: "task.new.config.agent.unavailable"))
                    } else {
                        Picker(String(localized: "task.new.config.agent"), selection: $viewModel.selectedAgent) {
                            ForEach(viewModel.agents) { agent in
                                Text(agent.name).tag(agent as Agent?)
                            }
                        }
                    }
                }

                if let models = viewModel.selectedAgentModels {
                    configMenu(
                        title: String(localized: "task.new.config.model"),
                        value: selectedModelLabel,
                        systemImage: "slider.horizontal.3",
                        isEnabled: isCurrentProfileContext
                    ) {
                        Picker(String(localized: "task.new.config.model"), selection: $viewModel.selectedModel) {
                            Text(String(localized: "task.new.config.model.default")).tag(nil as String?)
                            ForEach(models, id: \.self) { model in
                                Text(model).tag(model as String?)
                            }
                        }
                    }
                } else {
                    readOnlyChip(
                        title: String(localized: "task.new.config.model"),
                        value: String(localized: "task.new.config.model.default"),
                        systemImage: "slider.horizontal.3"
                    )
                }

                configMenu(
                    title: String(localized: "task.new.config.cwd"),
                    value: selectedCWDLabel,
                    systemImage: "folder",
                    isEnabled: isCurrentProfileContext
                ) {
                    Picker(String(localized: "task.new.config.cwd"), selection: $viewModel.selectedCWD) {
                        ForEach(viewModel.recentCwds, id: \.self) { cwd in
                            Text(cwd).tag(cwd as String?)
                        }
                        Text(String(localized: "task.new.config.cwd.manual")).tag(nil as String?)
                    }
                }

                configMenu(
                    title: String(localized: "task.new.config.permission"),
                    value: permissionLabel,
                    systemImage: "hand.raised",
                    isEnabled: isCurrentProfileContext
                ) {
                    Picker(String(localized: "task.new.config.permission"), selection: $viewModel.permissionMode) {
                        Text(String(localized: "permission.default")).tag("default")
                        Text(String(localized: "permission.accept_edits")).tag("accept_edits")
                        Text(String(localized: "permission.unrestricted")).tag("unrestricted")
                    }
                }

                readOnlyChip(
                    title: String(localized: "task.new.config.workspace"),
                    value: String(localized: "task.new.config.workspace.default"),
                    systemImage: "square.stack.3d.up"
                )
            }

            if viewModel.selectedCWD == nil {
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(localized: "task.new.config.cwd.manual"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField(String(localized: "task.new.config.cwd.placeholder"), text: $viewModel.customCWD)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .padding(10)
                        .background(Color(.tertiarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .disabled(viewModel.isSubmitting || !isCurrentProfileContext)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var submitBar: some View {
        VStack(spacing: 8) {
            Button(action: submit) {
                HStack(spacing: 8) {
                    if viewModel.isSubmitting {
                        ProgressView()
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                    Text(submitTitle)
                        .fontWeight(.semibold)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!viewModel.canSubmit(activeProfileID: appSession.activeProfileID) || appSession.apiClient == nil)

            Text(submitHelpText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }

    // MARK: - Chips

    private func configMenu<Content: View>(
        title: String,
        value: String,
        systemImage: String,
        isEnabled: Bool = true,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        Menu {
            content()
        } label: {
            chipLabel(title: title, value: value, systemImage: systemImage, showChevron: true)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || viewModel.isSubmitting)
    }

    private func readOnlyChip(title: String, value: String, systemImage: String) -> some View {
        chipLabel(title: title, value: value, systemImage: systemImage, showChevron: false)
    }

    private func chipLabel(title: String, value: String, systemImage: String, showChevron: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .lineLimit(1)
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if showChevron {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Presentation

    private var activeDesktopName: String {
        appSession.activeProfile?.activeDesktopName ?? String(localized: "control.no_desktop")
    }

    private var isCurrentProfileContext: Bool {
        viewModel.isCurrentProfileContext(activeProfileID: appSession.activeProfileID)
    }

    private var targetMessage: String {
        if viewModel.boundProfileID == nil {
            return String(localized: "task.new.target.unconfigured")
        }
        if !isCurrentProfileContext {
            return String(localized: "task.new.target.stale")
        }
        return String(
            format: String(localized: "task.new.target.message_format"),
            activeDesktopName
        )
    }

    private var connectionStateText: String {
        switch appSession.connectionState {
        case .unconfigured:
            return String(localized: "connection.state.unconfigured")
        case .connecting:
            return String(localized: "connection.state.connecting")
        case .connected:
            return String(localized: "connection.state.connected")
        case .reconnecting:
            return String(localized: "connection.state.reconnecting")
        case .unauthorized:
            return String(localized: "connection.state.unauthorized")
        case .incompatible:
            return String(localized: "connection.state.incompatible")
        case .offline(let message):
            return message.isEmpty ? String(localized: "connection.state.offline") : message
        }
    }

    private var connectionStateColor: Color {
        switch appSession.connectionState {
        case .connected:
            return .green
        case .connecting, .reconnecting:
            return .orange
        case .unconfigured:
            return .secondary
        case .offline, .unauthorized, .incompatible:
            return .red
        }
    }

    private var connectionStateIcon: String {
        switch appSession.connectionState {
        case .connected:
            return "checkmark.circle.fill"
        case .connecting, .reconnecting:
            return "arrow.triangle.2.circlepath"
        case .unconfigured:
            return "circle"
        case .offline:
            return "wifi.slash"
        case .unauthorized:
            return "lock.shield"
        case .incompatible:
            return "exclamationmark.triangle"
        }
    }

    private var selectedAgentLabel: String {
        viewModel.selectedAgent?.name ?? String(localized: "task.new.config.agent.unavailable")
    }

    private var selectedModelLabel: String {
        viewModel.selectedModel ?? String(localized: "task.new.config.model.default")
    }

    private var selectedCWDLabel: String {
        if let selectedCWD = viewModel.selectedCWD, !selectedCWD.isEmpty {
            return selectedCWD
        }
        let customCWD = viewModel.customCWD.trimmingCharacters(in: .whitespacesAndNewlines)
        return customCWD.isEmpty ? String(localized: "task.new.config.cwd.manual") : customCWD
    }

    private var permissionLabel: String {
        switch viewModel.permissionMode {
        case "accept_edits":
            return String(localized: "permission.accept_edits")
        case "unrestricted":
            return String(localized: "permission.unrestricted")
        default:
            return String(localized: "permission.default")
        }
    }

    private var submitTitle: String {
        if viewModel.isSubmitting {
            return String(localized: "task.new.starting")
        }
        return String(
            format: String(localized: "task.new.submit_format"),
            activeDesktopName
        )
    }

    private var submitHelpText: String {
        if viewModel.boundProfileID == nil || appSession.apiClient == nil {
            return String(localized: "task.new.submit.unavailable")
        }
        if !isCurrentProfileContext {
            return String(localized: "task.new.submit.stale")
        }
        return String(localized: "task.new.submit.help")
    }

    // MARK: - Actions

    @MainActor
    private func bindAndLoad() async {
        viewModel.configure(apiClient: appSession.apiClient, profileID: appSession.activeProfileID)
        guard appSession.apiClient != nil else { return }
        await viewModel.load()
    }

    @MainActor
    private func submit() {
        if viewModel.boundProfileID == appSession.activeProfileID {
            viewModel.configure(apiClient: appSession.apiClient, profileID: appSession.activeProfileID)
        }
        guard viewModel.canSubmit(activeProfileID: appSession.activeProfileID) else { return }

        if viewModel.permissionMode == "unrestricted" && !viewModel.confirmedUnrestricted {
            viewModel.showUnrestrictedAlert = true
            return
        }

        submitTask?.cancel()
        submitTask = Task { @MainActor in
            defer { submitTask = nil }
            if await viewModel.submit(activeProfileID: appSession.activeProfileID) != nil,
               !Task.isCancelled,
               viewModel.isCurrentProfileContext(activeProfileID: appSession.activeProfileID) {
                await appSession.reconcileForeground()
                dismiss()
            }
        }
    }
}

#Preview {
    NewTaskView()
        .environment(AppSession())
}
