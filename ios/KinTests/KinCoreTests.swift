import XCTest
@testable import Kin

final class KinCoreTests: XCTestCase {

    // MARK: - PairingPayload

    func testPairingParsesLANURL() throws {
        let payload = try PairingPayload.parse("http://192.168.1.20:7777/?token=secret123")
        XCTAssertEqual(payload.baseURL.absoluteString, "http://192.168.1.20:7777")
        XCTAssertEqual(payload.token, "secret123")
    }

    func testPairingParsesHTTPSURL() throws {
        let payload = try PairingPayload.parse("https://tunnel.example.com:7777/?token=abc123")
        XCTAssertEqual(payload.baseURL.absoluteString, "https://tunnel.example.com:7777")
        XCTAssertEqual(payload.token, "abc123")
    }

    func testPairingParsesRelayCredentials() throws {
        let payload = try PairingPayload.parse(
            "https://relay.example.com/?room=room-1&key=relay-key&token=pairing&pairing=1"
        )
        XCTAssertEqual(payload.relayRoom, "room-1")
        XCTAssertEqual(payload.relayKey, "relay-key")
        XCTAssertTrue(payload.isPairingSecret)
    }

    func testPairingRejectsPublicHTTP() {
        XCTAssertThrowsError(try PairingPayload.parse("http://example.com/?token=unsafe")) { error in
            guard let pairingError = error as? PairingError else {
                return XCTFail("Expected PairingError")
            }
            XCTAssertEqual(pairingError, .publicHTTP)
        }
    }

    func testPairingRejectsMissingToken() {
        XCTAssertThrowsError(try PairingPayload.parse("http://192.168.1.20:7777/"))
    }

    func testPairingRejectsEmbeddedCredentials() {
        XCTAssertThrowsError(try PairingPayload.parse("http://user:pass@192.168.1.20:7777/?token=x"))
    }

    func testPairingPreservesDeploymentPathAndRemovesFragment() throws {
        let payload = try PairingPayload.parse("http://10.0.0.5:7777/tasks/abc?token=secret#fragment")
        XCTAssertEqual(payload.baseURL.absoluteString, "http://10.0.0.5:7777/tasks/abc")
        XCTAssertEqual(payload.token, "secret")
    }

    func testPairingAcceptsTailnetIP() throws {
        // CGNAT range (100.x.x.x) is treated as public; only private ranges are allowed for HTTP
        XCTAssertThrowsError(try PairingPayload.parse("http://100.90.10.2:7777/?token=tailnet"))
    }

    func testPairingTokenNotInDescription() throws {
        let payload = try PairingPayload.parse("http://192.168.1.20:7777/?token=supersecret")
        let desc = String(describing: payload)
        XCTAssertFalse(desc.contains("supersecret"), "Token must not appear in description: \(desc)")
    }

    // MARK: - ApprovalStatus

    func testApprovalStatusDecodes() throws {
        let json = """
        ["pending", "approved", "denied", "expired", "bogus_value"]
        """.data(using: .utf8)!
        let statuses = try JSONDecoder().decode([ApprovalStatus].self, from: json)
        XCTAssertEqual(statuses, [.pending, .approved, .denied, .expired, .unknown])
    }

    // MARK: - TaskStatus

    func testTaskStatusDecodes() throws {
        let json = """
        ["queued", "running", "waiting_approval", "waiting_input", "completed", "failed", "cancelled", "unknown_type"]
        """.data(using: .utf8)!
        let statuses = try JSONDecoder().decode([TaskStatus].self, from: json)
        XCTAssertEqual(statuses, [.queued, .running, .waitingApproval, .waitingInput, .completed, .failed, .cancelled, .unknown])
    }

    // MARK: - KinTask

    func testKinTaskIsTerminal() {
        let base = makeTask(status: .queued)
        XCTAssertFalse(base.isTerminal)

        let completed = makeTask(status: .completed)
        XCTAssertTrue(completed.isTerminal)

        let failed = makeTask(status: .failed)
        XCTAssertTrue(failed.isTerminal)

        let cancelled = makeTask(status: .cancelled)
        XCTAssertTrue(cancelled.isTerminal)
    }

    func testTaskPresentationBuildsSummaryForWorkbench() {
        let task = KinTask(
            id: "t1",
            status: .running,
            agent: "claude-code",
            model: "opus",
            cwd: "/Users/me/project",
            prompt: "Refactor the task detail view",
            permissionMode: "default",
            workspaceMode: nil,
            approvalIds: nil,
            questionIds: nil,
            createdAt: 1_767_225_600_000,
            startedAt: nil,
            finishedAt: nil,
            elapsedSeconds: 125,
            costUSD: 0.023,
            sessionRef: nil,
            error: nil
        )

        let summary = TaskPresentation.summary(for: task)

        XCTAssertEqual(summary.title, "Refactor the task detail view")
        XCTAssertEqual(summary.location, "/Users/me/project")
        XCTAssertEqual(summary.agentAndModel, "claude-code / opus")
        XCTAssertEqual(summary.elapsed, "2m 5s")
        XCTAssertEqual(summary.cost, "$0.02")
        XCTAssertFalse(summary.needsUserAction)
    }

    func testTaskPresentationMarksWaitingTasksAsNeedsAction() {
        XCTAssertTrue(TaskPresentation.summary(for: makeTask(status: .waitingApproval)).needsUserAction)
        XCTAssertTrue(TaskPresentation.summary(for: makeTask(status: .waitingInput)).needsUserAction)
        XCTAssertFalse(TaskPresentation.summary(for: makeTask(status: .running)).needsUserAction)
    }

    func testTaskPresentationFilterMatchesModelAndStatus() {
        let modelTask = KinTask(
            id: "model",
            status: .running,
            agent: "claude-code",
            model: "opus",
            cwd: "/tmp",
            prompt: "ship",
            permissionMode: nil,
            workspaceMode: nil,
            approvalIds: nil,
            questionIds: nil,
            createdAt: 1,
            startedAt: nil,
            finishedAt: nil,
            elapsedSeconds: nil,
            costUSD: nil,
            sessionRef: nil,
            error: nil
        )
        let waitingTask = makeTask(status: .waitingApproval)

        XCTAssertEqual(TaskPresentation.filter([modelTask, waitingTask], query: "opus"), [modelTask])
        XCTAssertEqual(TaskPresentation.filter([modelTask, waitingTask], query: "waiting_approval"), [waitingTask])
    }

    func testTaskPresentationDetectsStaleProfileContext() {
        let bound = UUID()
        let active = UUID()

        XCTAssertTrue(TaskPresentation.isCurrentProfileContext(boundProfileID: bound, activeProfileID: bound))
        XCTAssertFalse(TaskPresentation.isCurrentProfileContext(boundProfileID: bound, activeProfileID: active))
        XCTAssertTrue(TaskPresentation.isCurrentProfileContext(boundProfileID: nil, activeProfileID: active))
        XCTAssertTrue(TaskPresentation.isCurrentProfileContext(boundProfileID: bound, activeProfileID: nil))
    }

    func testProjectPresentationBuildsScanSummary() {
        let project = Project(
            id: "p1",
            name: "Kin",
            mode: "ship",
            status: "active",
            softProgress: "  Build readable one-pager cards  ",
            createdAt: 1,
            updatedAt: 2,
            lastActiveAt: 1_767_225_600_000,
            roots: ["/Users/me/openkin"],
            onePagerPath: nil
        )
        let pulse = ProjectPulse(
            projectId: "p1",
            generatedAt: 1,
            windowDays: 7,
            sessionTotal: 9,
            sessionWindow: 4,
            sessionsRunning: 2,
            sessionsWaiting: 1,
            lastSessionAt: nil,
            gitAvailable: true,
            gitRoot: "/Users/me/openkin",
            commitWindow: 3,
            autoMarkdown: ""
        )

        let summary = ProjectPresentation.summary(for: project, pulse: pulse)

        XCTAssertEqual(summary.title, "Kin")
        XCTAssertEqual(summary.modeLabel, "Ship")
        XCTAssertEqual(summary.statusLabel, "Active")
        XCTAssertEqual(summary.progress, "Build readable one-pager cards")
        XCTAssertEqual(summary.root, "/Users/me/openkin")
        XCTAssertEqual(summary.sessionWindow, 4)
        XCTAssertEqual(summary.runningCount, 2)
        XCTAssertEqual(summary.waitingCount, 1)
        XCTAssertTrue(summary.hasLiveWork)
    }

    func testProjectPresentationExtractsOnePagerFocus() {
        let pager = OnePager(
            projectId: "p1",
            markdown: "# Kin\n\nShip reliable remote control.",
            updatedAt: 1,
            onePagerSummary: OnePagerSummary(
                name: "Kin",
                mode: nil,
                northStar: "Ship reliable remote control",
                focus: "Projects and Library",
                next: ["Verify build", "Run review"],
                empty: false
            )
        )

        let focus = ProjectPresentation.onePagerFocus(for: pager)

        XCTAssertEqual(focus.northStar, "Ship reliable remote control")
        XCTAssertEqual(focus.focus, "Projects and Library")
        XCTAssertEqual(focus.next, ["Verify build", "Run review"])
        XCTAssertEqual(focus.displayMarkdown, "# Kin\n\nShip reliable remote control.")
        XCTAssertFalse(focus.isEmpty)
    }

    func testProjectPresentationSuppressesEmptyTemplateMarkdown() {
        let pager = OnePager(
            projectId: "p1",
            markdown: """
            # Kin

            ## 项目描述
            这是什么、给谁用、边界在哪（3～8 行即可）。

            ## North Star
            你为什么做这个项目（用户主权；刷新不会改这里）。

            ## Current Focus
            当下唯一主线（越短越好）。

            <!-- kin:auto:start -->
            ## Pulse（自动）
            _点击「刷新封面」写入会话/提交活跃与建议下一步。_
            <!-- kin:auto:end -->
            """,
            updatedAt: 1,
            onePagerSummary: nil
        )

        let focus = ProjectPresentation.onePagerFocus(for: pager)

        XCTAssertNil(focus.displayMarkdown)
        XCTAssertTrue(focus.isEmpty)
    }

    func testArtifactPresentationBuildsReadableSummary() {
        let artifact = Artifact(
            id: "a1",
            title: "  ",
            kind: "markdown_note",
            size: 1_536,
            status: "saved",
            sourceTaskId: "t1",
            sourceTaskTitle: "Refactor UI",
            createdAt: 1,
            updatedAt: 1_767_225_600_000
        )

        let summary = ArtifactPresentation.summary(for: artifact)

        XCTAssertNil(summary.title)
        XCTAssertEqual(summary.kindLabel, "Markdown Note")
        XCTAssertEqual(summary.statusLabel, "Saved")
        XCTAssertEqual(summary.sizeText, "2 KB")
        XCTAssertEqual(summary.sourceTitle, "Refactor UI")
        XCTAssertFalse(summary.isArchived)
    }

    func testSettingsPresentationSummarizesProfileCredentialScope() throws {
        let activeID = UUID()
        let profile = ServerProfile(
            id: activeID,
            displayName: "Work Mac",
            baseURL: try XCTUnwrap(URL(string: "https://desktop.example.test:7777")),
            relayKey: nil,
            relayRoom: nil,
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 2),
            credentialScope: .device
        )

        let summary = SettingsPresentation.profileSummary(for: profile, activeProfileID: activeID)

        XCTAssertEqual(summary.title, "Work Mac")
        XCTAssertEqual(summary.origin, "https://desktop.example.test:7777")
        XCTAssertEqual(summary.transportKey, "desktop.transport.https_tunnel")
        XCTAssertEqual(summary.credentialKey, "settings.profile.credential.device")
        XCTAssertEqual(summary.managementAccessKey, "settings.management.read_only")
        XCTAssertTrue(summary.isActive)
        XCTAssertFalse(summary.canManageDaemon)
    }

    func testSettingsPresentationMarksMasterCredentialAsManageable() throws {
        let profile = ServerProfile(
            id: UUID(),
            displayName: "Admin Mac",
            baseURL: try XCTUnwrap(URL(string: "http://192.168.1.20:7777")),
            relayKey: nil,
            relayRoom: nil,
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 2),
            credentialScope: .master
        )

        let summary = SettingsPresentation.profileSummary(for: profile, activeProfileID: nil)

        XCTAssertEqual(summary.transportKey, "desktop.transport.lan_http")
        XCTAssertEqual(summary.credentialKey, "settings.profile.credential.master")
        XCTAssertEqual(summary.managementAccessKey, "settings.management.full")
        XCTAssertFalse(summary.isActive)
        XCTAssertTrue(summary.canManageDaemon)
    }

    func testOperationsPresentationGatesProviderWrites() {
        let loadedProfileID = UUID()

        XCTAssertFalse(OperationsPresentation.canSaveProvider(
            loadedProfileID: loadedProfileID,
            activeProfileID: loadedProfileID,
            canManageDaemon: false,
            isSaving: false,
            selectedID: "provider-1",
            name: "Local",
            baseURL: "http://localhost:11434",
            model: "llama"
        ))

        XCTAssertFalse(OperationsPresentation.canSaveProvider(
            loadedProfileID: loadedProfileID,
            activeProfileID: loadedProfileID,
            canManageDaemon: true,
            isSaving: false,
            selectedID: nil,
            name: "Local",
            baseURL: "http://localhost:11434",
            model: "llama"
        ))

        XCTAssertFalse(OperationsPresentation.canSaveProvider(
            loadedProfileID: loadedProfileID,
            activeProfileID: UUID(),
            canManageDaemon: true,
            isSaving: false,
            selectedID: "provider-1",
            name: "Local",
            baseURL: "http://localhost:11434",
            model: "llama"
        ))

        XCTAssertTrue(OperationsPresentation.canSaveProvider(
            loadedProfileID: loadedProfileID,
            activeProfileID: loadedProfileID,
            canManageDaemon: true,
            isSaving: false,
            selectedID: "provider-1",
            name: " Local ",
            baseURL: " http://localhost:11434 ",
            model: " llama "
        ))
    }

    func testOperationsPresentationRequiresCurrentLoadedProfileForMutations() {
        let profileID = UUID()

        XCTAssertTrue(OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: profileID,
            activeProfileID: profileID,
            canManageDaemon: true
        ))
        XCTAssertFalse(OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: profileID,
            activeProfileID: UUID(),
            canManageDaemon: true
        ))
        XCTAssertFalse(OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: nil,
            activeProfileID: profileID,
            canManageDaemon: true
        ))
        XCTAssertFalse(OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: profileID,
            activeProfileID: profileID,
            canManageDaemon: false
        ))
    }

    func testOperationsPresentationFormatsStatuses() {
        XCTAssertEqual(OperationsPresentation.displayLabel("signed_in"), "Signed In")
        XCTAssertEqual(OperationsPresentation.displayLabel("rate-limited"), "Rate Limited")
        XCTAssertEqual(OperationsPresentation.displayLabel("  "), "Unknown")
        XCTAssertEqual(OperationsPresentation.agentAuthStatusLabel("signed_in"), "Signed In")
        XCTAssertEqual(OperationsPresentation.agentAuthStatusLabel("not_signed_in"), "Not Signed In")
        XCTAssertEqual(OperationsPresentation.usageStatusLabel("over"), "Over Limit")
        XCTAssertEqual(OperationsPresentation.providerKindLabel("openai-compatible"), "OpenAI Compatible")
        XCTAssertEqual(OperationsPresentation.workerStateLabel("online"), "Online")
    }

    @MainActor
    func testNewTaskViewModelRequiresCurrentProfileForSubmit() {
        let initialProfileID = UUID()
        let nextProfileID = UUID()
        let client = APIClient(baseURL: URL(string: "http://127.0.0.1:7777")!, token: "token")
        let model = NewTaskViewModel()
        model.configure(apiClient: client, profileID: initialProfileID)
        model.prompt = "Ship the iOS task composer"

        XCTAssertTrue(model.canSubmit(activeProfileID: initialProfileID))
        XCTAssertFalse(model.canSubmit(activeProfileID: nextProfileID))
        XCTAssertFalse(model.canSubmit(activeProfileID: nil))
    }

    @MainActor
    func testNewTaskViewModelRequiresClientForSubmit() {
        let profileID = UUID()
        let model = NewTaskViewModel()
        model.configure(apiClient: nil, profileID: profileID)
        model.prompt = "Ship the iOS task composer"

        XCTAssertFalse(model.canSubmit(activeProfileID: profileID))
    }

    @MainActor
    func testNewTaskViewModelClearsRemoteOptionsOnProfileSwitch() {
        let firstProfileID = UUID()
        let secondProfileID = UUID()
        let model = NewTaskViewModel()
        model.configure(apiClient: nil, profileID: firstProfileID)
        model.agents = [
            Agent(
                id: "claude-code",
                name: "Claude Code",
                kind: "cli",
                available: true,
                isDefault: true,
                capabilities: ["run"],
                model: "opus",
                models: ["opus"]
            )
        ]
        model.recentCwds = ["/Users/me/project"]
        model.selectedAgent = model.agents.first
        model.selectedModel = "opus"
        model.selectedCWD = "/Users/me/project"
        model.customCWD = "/Users/me/manual"
        model.prompt = "Keep my draft"

        model.configure(apiClient: nil, profileID: secondProfileID)

        XCTAssertTrue(model.agents.isEmpty)
        XCTAssertTrue(model.recentCwds.isEmpty)
        XCTAssertNil(model.selectedAgent)
        XCTAssertNil(model.selectedModel)
        XCTAssertNil(model.selectedCWD)
        XCTAssertEqual(model.customCWD, "/Users/me/manual")
        XCTAssertEqual(model.prompt, "Keep my draft")
    }

    @MainActor
    func testNewTaskViewModelDropsSubmittedTaskIfProfileChangesDuringRequest() async {
        let firstProfileID = UUID()
        let secondProfileID = UUID()
        let model = NewTaskViewModel()
        model.configure(
            loadConfiguration: nil,
            createTask: { draft in
                try await Task.sleep(nanoseconds: 50_000_000)
                return KinTask(
                    id: "created",
                    status: .queued,
                    agent: draft.agent,
                    model: draft.model,
                    cwd: draft.cwd,
                    prompt: draft.prompt,
                    permissionMode: draft.permissionMode,
                    workspaceMode: draft.workspaceMode,
                    approvalIds: nil,
                    questionIds: nil,
                    createdAt: 1,
                    startedAt: nil,
                    finishedAt: nil,
                    elapsedSeconds: nil,
                    costUSD: nil,
                    sessionRef: nil,
                    error: nil
                )
            },
            profileID: firstProfileID
        )
        model.agents = [
            Agent(
                id: "kin",
                name: "Kin",
                kind: "builtin",
                available: true,
                isDefault: true,
                capabilities: ["run"],
                model: nil,
                models: nil
            )
        ]
        model.selectedAgent = model.agents.first
        model.selectedCWD = "/tmp"
        model.prompt = "Run checks"

        let submission = Task { @MainActor in
            await model.submit(activeProfileID: firstProfileID)
        }
        while !model.isSubmitting {
            await Task.yield()
        }

        model.configure(apiClient: nil, profileID: secondProfileID)
        let result = await submission.value

        XCTAssertNil(result)
        XCTAssertNil(model.createdTask)
    }

    @MainActor
    func testNewTaskViewModelBuildsTrimmedDraft() {
        let model = NewTaskViewModel()
        model.agents = [
            Agent(
                id: "claude-code",
                name: "Claude Code",
                kind: "cli",
                available: true,
                isDefault: true,
                capabilities: ["run"],
                model: "opus",
                models: ["opus", "sonnet"]
            )
        ]
        model.selectedAgent = model.agents.first
        model.selectedModel = "sonnet"
        model.selectedCWD = nil
        model.customCWD = "  /Users/me/project  "
        model.prompt = "  Refactor New Task  "
        model.permissionMode = "accept_edits"

        let draft = model.taskDraft()

        XCTAssertEqual(draft.prompt, "Refactor New Task")
        XCTAssertEqual(draft.agent, "claude-code")
        XCTAssertEqual(draft.model, "sonnet")
        XCTAssertEqual(draft.cwd, "/Users/me/project")
        XCTAssertEqual(draft.permissionMode, "accept_edits")
        XCTAssertNil(draft.workspaceMode)
    }

    @MainActor
    func testNewTaskViewModelOmitsModelWhenAgentDoesNotAdvertiseChoices() {
        let model = NewTaskViewModel()
        model.agents = [
            Agent(
                id: "kin",
                name: "Kin",
                kind: "builtin",
                available: true,
                isDefault: true,
                capabilities: ["run"],
                model: "default",
                models: nil
            )
        ]
        model.selectedAgent = model.agents.first
        model.selectedModel = "should-not-submit"
        model.selectedCWD = "/tmp"
        model.prompt = "Run checks"

        XCTAssertNil(model.taskDraft().model)
    }

    func testTaskLimitWaitDecodes() throws {
        let data = Data("""
        {
          "task_id": "t1",
          "event_epoch": 2,
          "user_seq": 8,
          "agent": "claude-code",
          "provider": "claude",
          "state": "waiting",
          "attempts": 3,
          "next_probe_at": 1767225600000,
          "first_wait_at": 1767225500000,
          "updated_at": 1767225550000
        }
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let wait = try decoder.decode(TaskLimitWait.self, from: data)
        XCTAssertEqual(wait.taskId, "t1")
        XCTAssertEqual(wait.state, "waiting")
        XCTAssertEqual(wait.attempts, 3)
    }

    private func makeTask(status: TaskStatus) -> KinTask {
        KinTask(
            id: "t1",
            status: status,
            agent: "kin",
            model: nil,
            cwd: "/tmp",
            prompt: "test",
            permissionMode: nil,
            workspaceMode: nil,
            approvalIds: nil,
            questionIds: nil,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000),
            startedAt: nil,
            finishedAt: nil,
            elapsedSeconds: nil,
            costUSD: nil,
            sessionRef: nil,
            error: nil
        )
    }

    // MARK: - ServerMessage

    func testServerMessageDecodesTaskUpdate() throws {
        let decoder = JSONDecoder()
        let data = Data("""
        {"kind": "task_update", "data": {"id": "t1", "status": "running", "agent": "kin", "cwd": "/tmp", "prompt": "hello", "created_at": 1767225600000}}
        """.utf8)
        let message = try decoder.decode(ServerMessage.self, from: data)
        guard case .taskUpdate(let task) = message else { return XCTFail("Expected taskUpdate") }
        XCTAssertEqual(task.id, "t1")
        XCTAssertEqual(task.status, .running)
    }

    func testServerMessageDecodesTaskDeleted() throws {
        let data = Data("""
        {"kind": "task_deleted", "data": {"id": "t1"}}
        """.utf8)
        let message = try JSONDecoder().decode(ServerMessage.self, from: data)
        guard case .taskDeleted(let id) = message else { return XCTFail("Expected taskDeleted") }
        XCTAssertEqual(id, "t1")
    }

    func testServerMessageDecodesCanonicalEventPayload() throws {
        let data = Data("""
        {"kind":"event","data":{"task_id":"t1","event_epoch":0,"seq":1,"ts":1767225600000,"type":"message","payload":{"role":"assistant","content":"hello"}}}
        """.utf8)
        let message = try JSONDecoder().decode(ServerMessage.self, from: data)
        guard case .event(let event) = message else { return XCTFail("Expected event") }
        XCTAssertEqual(event.taskId, "t1")
        XCTAssertEqual(event.content, .message(role: "assistant", text: "hello"))
    }

    func testServerMessageDecodesUnknownType() throws {
        let data = Data("""
        {"kind": "future_event", "data": {"some": "data"}}
        """.utf8)
        let message = try JSONDecoder().decode(ServerMessage.self, from: data)
        guard case .unknown(let type, _) = message else { return XCTFail("Expected unknown") }
        XCTAssertEqual(type, "future_event")
    }

    // MARK: - ConnectionState

    func testConnectionStateEquality() {
        XCTAssertEqual(ConnectionState.unconfigured, ConnectionState.unconfigured)
        XCTAssertEqual(ConnectionState.connecting, ConnectionState.connecting)
        XCTAssertEqual(ConnectionState.connected, ConnectionState.connected)
        XCTAssertNotEqual(ConnectionState.unconfigured, ConnectionState.connected)
        XCTAssertTrue(ConnectionState.connected.isConnected)
        XCTAssertFalse(ConnectionState.unconfigured.isConnected)
    }

    func testServerProfilesLoadMostRecentlyAccessedFirst() throws {
        let defaults = UserDefaults.standard
        let originalProfiles = defaults.data(forKey: "kin_server_profiles")
        defer {
            if let originalProfiles {
                defaults.set(originalProfiles, forKey: "kin_server_profiles")
            } else {
                defaults.removeObject(forKey: "kin_server_profiles")
            }
        }
        let old = ServerProfile(
            id: UUID(),
            displayName: "old",
            baseURL: try XCTUnwrap(URL(string: "https://old.example.test")),
            relayKey: nil,
            relayRoom: nil,
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 1)
        )
        let recent = ServerProfile(
            id: UUID(),
            displayName: "recent",
            baseURL: try XCTUnwrap(URL(string: "https://recent.example.test")),
            relayKey: "key",
            relayRoom: "room",
            dateAdded: Date(timeIntervalSince1970: 2),
            lastAccessed: Date(timeIntervalSince1970: 3)
        )
        UserDefaults.saveServerProfiles([old, recent])

        XCTAssertEqual(UserDefaults.loadServerProfiles().first?.id, recent.id)
    }

    func testServerProfilePresentationFallsBackToHost() throws {
        let profile = ServerProfile(
            id: UUID(),
            displayName: "  ",
            baseURL: try XCTUnwrap(URL(string: "https://desktop.example.test:7777")),
            relayKey: nil,
            relayRoom: nil,
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 1)
        )

        XCTAssertEqual(profile.activeDesktopName, "desktop.example.test")
        XCTAssertEqual(profile.displayHost, "desktop.example.test")
        XCTAssertEqual(profile.transport, .httpsTunnel)
    }

    func testServerProfilePresentationClassifiesRelayBeforeScheme() throws {
        let profile = ServerProfile(
            id: UUID(),
            displayName: "Work Mac",
            baseURL: try XCTUnwrap(URL(string: "http://192.168.1.20:7777")),
            relayKey: "relay-key",
            relayRoom: "room",
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 1)
        )

        XCTAssertEqual(profile.activeDesktopName, "Work Mac")
        XCTAssertEqual(profile.transport, .relay)
    }

    @MainActor
    func testActivatingProfileClearsRemoteSnapshotImmediately() throws {
        let defaults = UserDefaults.standard
        let originalProfiles = defaults.data(forKey: "kin_server_profiles")
        defer {
            if let originalProfiles {
                defaults.set(originalProfiles, forKey: "kin_server_profiles")
            } else {
                defaults.removeObject(forKey: "kin_server_profiles")
            }
        }
        defaults.removeObject(forKey: "kin_server_profiles")

        let session = AppSession()
        let target = ServerProfile(
            id: UUID(),
            displayName: "Target Mac",
            baseURL: try XCTUnwrap(URL(string: "https://target.example.test")),
            relayKey: nil,
            relayRoom: nil,
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 1)
        )
        session.installRemoteSnapshotForTesting(
            tasks: [makeTask(status: .running)],
            approvals: [
                Approval(
                    id: "approval-1",
                    taskId: "task-1",
                    status: .pending,
                    createdAt: 1
                )
            ],
            questions: [
                UserQuestion(
                    id: "question-1",
                    taskId: "task-1",
                    question: "Continue?",
                    type: .freeText,
                    options: nil,
                    otherText: nil,
                    answeredAt: nil
                )
            ]
        )

        session.activate(profile: target)

        XCTAssertEqual(session.activeProfileID, target.id)
        XCTAssertTrue(session.tasks.isEmpty)
        XCTAssertTrue(session.approvals.isEmpty)
        XCTAssertTrue(session.questions.isEmpty)
    }

    // MARK: - QuestionType

    func testQuestionTypeDecodes() throws {
        let json = """
        ["single_select", "multi_select", "free_text", "unknown_type"]
        """.data(using: .utf8)!
        let types = try JSONDecoder().decode([QuestionType].self, from: json)
        XCTAssertEqual(types, [.singleSelect, .multiSelect, .freeText, .unknown])
    }

    func testConsoleModelsDecodeDaemonShapes() throws {
        let decoder = JSONDecoder()

        let artifact = try decoder.decode(Artifact.self, from: Data("""
        {"id":"a1","title":"Notes","kind":"markdown","size":42,"status":"saved","source_task_id":"t1","created_at":1,"updated_at":2}
        """.utf8))
        XCTAssertEqual(artifact.sourceTaskId, "t1")

        let project = try decoder.decode(Project.self, from: Data("""
        {"id":"p1","name":"Kin","mode":"ship","status":"active","soft_progress":"Build","created_at":1,"updated_at":2,"last_active_at":3}
        """.utf8))
        XCTAssertEqual(project.name, "Kin")

        let routine = try decoder.decode(Routine.self, from: Data("""
        {"id":"r1","project_id":"p1","cwd":"/tmp","agent":"kin","permission_mode":"default","prompt":"check","interval_secs":3600,"enabled":true,"next_due_at":4,"consec_failures":0,"created_at":1,"title":"Check"}
        """.utf8))
        XCTAssertEqual(routine.projectId, "p1")

        let providers = try decoder.decode(ProvidersResponse.self, from: Data("""
        {"active_id":"provider-1","providers":[{"id":"provider-1","name":"Local","kind":"openai","base_url":"http://localhost","model":"model","active":true}]}
        """.utf8))
        XCTAssertEqual(providers.activeId, "provider-1")
        XCTAssertEqual(providers.providers.first?.baseURL, "http://localhost")
    }
}
