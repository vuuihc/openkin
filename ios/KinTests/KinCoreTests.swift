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

    func testPairingParsesDesktopIdentity() throws {
        let payload = try PairingPayload.parse(
            "https://relay.example.com/?room=room-1&key=relay-key&token=pairing&pairing=1&desktop_id=desktop_1234abcd&desktop_name=Work%20Mac"
        )
        XCTAssertEqual(payload.desktopID, "desktop_1234abcd")
        XCTAssertEqual(payload.desktopName, "Work Mac")
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
            projectId: nil,
            prompt: "Refactor the task detail view",
            title: nil,
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
            projectId: nil,
            prompt: "ship",
            title: nil,
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

    // MARK: - Chat grouping

    func testChatGroupsFilesSessionsUnderTheirAssignedProject() {
        let project = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let filed = makeTask(id: "filed", status: .succeeded, cwd: "/somewhere/else", projectId: "p1")

        let groups = TaskPresentation.chatGroups(tasks: [filed], projects: [project])

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].kind, .project(id: "p1"))
        XCTAssertEqual(groups[0].title, "OpenKin")
        XCTAssertEqual(groups[0].sessions.map(\.id), ["filed"])
    }

    func testChatGroupsFallsBackToTheProjectRootWhenNoProjectIsAssigned() {
        let project = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let inRoot = makeTask(id: "in-root", status: .succeeded, cwd: "/Users/me/openkin")

        let groups = TaskPresentation.chatGroups(tasks: [inRoot], projects: [project])

        XCTAssertEqual(groups.map(\.id), ["project:p1"])
        XCTAssertEqual(groups[0].sessions.map(\.id), ["in-root"])
    }

    func testChatGroupsMatchesRootsDespiteTrailingSeparator() {
        let project = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin/"])
        let inRoot = makeTask(id: "in-root", status: .succeeded, cwd: "/Users/me/openkin")

        XCTAssertEqual(TaskPresentation.chatGroups(tasks: [inRoot], projects: [project]).map(\.id), ["project:p1"])
    }

    /// A session the daemon filed under one project must not be re-filed under
    /// another project that happens to have an overlapping root.
    func testChatGroupsKeepsAnAssignedSessionOutOfAnotherProjectsRoot() {
        let first = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let second = makeProject(id: "p2", name: "Kin", roots: ["/Users/me/openkin"])
        let filed = makeTask(id: "filed", status: .succeeded, cwd: "/Users/me/openkin", projectId: "p2")

        let groups = TaskPresentation.chatGroups(tasks: [filed], projects: [first, second])

        XCTAssertEqual(groups.map(\.id), ["project:p2"])
    }

    func testChatGroupsBucketsUnclaimedSessionsByFolderAndUnfiledOnesLast() {
        let project = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let loose = makeTask(id: "loose", status: .succeeded, cwd: "/Users/me/scratch/", createdAt: 3)
        let homeless = makeTask(id: "homeless", status: .succeeded, cwd: "", createdAt: 2)
        let filed = makeTask(id: "filed", status: .succeeded, cwd: "/Users/me/openkin", createdAt: 1)

        let groups = TaskPresentation.chatGroups(tasks: [loose, homeless, filed], projects: [project])

        XCTAssertEqual(groups.map(\.id), ["cwd:/Users/me/scratch", "unfiled", "project:p1"])
        XCTAssertEqual(groups[0].title, "scratch")
        XCTAssertTrue(groups[1].isUnfiled)
        XCTAssertEqual(groups[1].title, "")
    }

    func testChatGroupsOrdersSessionsByMostRecentActivity() {
        let project = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let oldest = makeTask(id: "oldest", status: .succeeded, cwd: "/Users/me/openkin", createdAt: 1_000)
        let resumed = makeTask(
            id: "resumed",
            status: .running,
            cwd: "/Users/me/openkin",
            createdAt: 500,
            startedAt: 9_000
        )
        let finished = makeTask(
            id: "finished",
            status: .succeeded,
            cwd: "/Users/me/openkin",
            createdAt: 700,
            finishedAt: 5_000
        )

        let groups = TaskPresentation.chatGroups(tasks: [oldest, resumed, finished], projects: [project])

        XCTAssertEqual(groups[0].sessions.map(\.id), ["resumed", "finished", "oldest"])
        XCTAssertEqual(groups[0].runningCount, 1)
    }

    func testChatGroupsSkipsProjectsWithNoSessionsAndLeavesClaimsToTheirs() {
        let used = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let unused = makeProject(id: "p2", name: "Empty", roots: ["/Users/me/empty"])
        let filed = makeTask(id: "filed", status: .succeeded, cwd: "/Users/me/openkin")

        let groups = TaskPresentation.chatGroups(tasks: [filed], projects: [used, unused])

        XCTAssertEqual(groups.map(\.id), ["project:p1"])
    }

    func testChatGroupsSortsGroupsByTheirNewestSession() {
        let project = makeProject(id: "p1", name: "OpenKin", roots: ["/Users/me/openkin"])
        let quietProject = makeTask(id: "old", status: .succeeded, cwd: "/Users/me/openkin", createdAt: 10)
        let loudFolder = makeTask(id: "new", status: .succeeded, cwd: "/Users/me/scratch", createdAt: 99)

        let groups = TaskPresentation.chatGroups(tasks: [quietProject, loudFolder], projects: [project])

        XCTAssertEqual(groups.map(\.id), ["cwd:/Users/me/scratch", "project:p1"])
    }

    func testKinTaskDecodesProjectIdWhenPresentAndAbsent() throws {
        let filed = try decode(KinTask.self, """
        {"id":"t1","status":"running","agent":"kin","cwd":"/tmp","project_id":"p1",
         "prompt":"hello","title":"Greeting","created_at":1767225600000}
        """)
        XCTAssertEqual(filed.projectId, "p1")
        XCTAssertEqual(filed.title, "Greeting")

        let unfiled = try decode(KinTask.self, """
        {"id":"t2","status":"running","agent":"kin","cwd":"/tmp",
         "prompt":"hello","created_at":1767225600000}
        """)
        XCTAssertNil(unfiled.projectId)
        // Rows from before the daemon named sessions carry no title at all.
        XCTAssertNil(unfiled.title)
    }

    private func makeProject(id: String, name: String, roots: [String]?) -> Project {
        Project(
            id: id,
            name: name,
            mode: "ship",
            status: "active",
            softProgress: nil,
            createdAt: 1,
            updatedAt: 1,
            lastActiveAt: 1,
            roots: roots,
            onePagerPath: nil
        )
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
                models: [AgentModelOption(id: "opus", label: "Opus", tier: nil)]
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
                    projectId: nil,
                    prompt: draft.prompt,
                    title: nil,
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
                models: [
                    AgentModelOption(id: "opus", label: "Opus", tier: nil),
                    AgentModelOption(id: "sonnet", label: nil, tier: nil)
                ]
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
    func testNewTaskViewModelExposesAgentModelLabels() {
        let model = NewTaskViewModel()
        model.agents = [
            Agent(
                id: "claude-code",
                name: "Claude Code",
                kind: "cli",
                available: true,
                isDefault: false,
                capabilities: ["run"],
                model: "opus",
                models: [
                    AgentModelOption(id: "opus", label: "Opus", tier: nil),
                    AgentModelOption(id: "sonnet", label: nil, tier: nil)
                ]
            )
        ]
        model.selectAgent(model.agents.first)

        XCTAssertEqual(model.selectedAgentModels?.map(\.displayLabel), ["Opus", "sonnet"])
        XCTAssertEqual(model.selectedAgentModels?.map(\.id), ["opus", "sonnet"])

        // The chip resolves the id back to the advertised label.
        XCTAssertEqual(model.modelLabel(for: "opus"), "Opus")
        // An id the agent does not advertise (its own default) renders as-is.
        XCTAssertEqual(model.modelLabel(for: "default"), "default")
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
        let wait = try APIClient.makeResponseDecoder().decode(TaskLimitWait.self, from: data)
        XCTAssertEqual(wait.taskId, "t1")
        XCTAssertEqual(wait.state, "waiting")
        XCTAssertEqual(wait.attempts, 3)
        XCTAssertEqual(wait.nextProbeAt, 1767225600000)
    }

    // MARK: - Daemon response decoding
    //
    // These decode real daemon payloads with the exact decoder the app uses
    // (`APIClient.makeResponseDecoder()`), so they pin the wire contract rather
    // than a decoder configured in the test. Decoding any of these with a
    // mismatched key strategy is what the iOS client used to fail on after a
    // successful pairing, reporting `DecodingError.keyNotFound` to the user as
    // "The data couldn't be read because it is missing."

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try APIClient.makeResponseDecoder().decode(type, from: Data(json.utf8))
    }

    func testAgentDecodesDaemonPayload() throws {
        let agents = try decode([Agent].self, """
        [{"id":"claude-code","name":"Claude Code","kind":"cli","installed":true,
          "available":true,"default":false,"capabilities":["run"],
          "model":"opus","model_list_source":"recommended","model_list_status":"available",
          "models":[{"id":"opus","label":"Opus"},{"id":"sonnet","label":"Sonnet"},
                    {"id":"haiku","label":"Haiku","tier":"fast"},
                    {"id":"deepseek-v4-flash-0731","tier":"fast"}]},
         {"id":"kin","name":"Kin","kind":"builtin","installed":true,"available":true,
          "default":true,"capabilities":["run"],"model":"default",
          "model_list_source":"configured","model_list_status":"default_only"}]
        """)
        XCTAssertEqual(agents.count, 2)

        let claude = agents[0]
        XCTAssertEqual(claude.id, "claude-code")
        XCTAssertEqual(claude.model, "opus")
        XCTAssertEqual(claude.models?.count, 4)
        XCTAssertEqual(claude.models?.first?.id, "opus")
        XCTAssertEqual(claude.models?.first?.displayLabel, "Opus")
        XCTAssertNil(claude.models?.first?.tier)
        XCTAssertEqual(claude.models?[2].displayLabel, "Haiku")
        XCTAssertEqual(claude.models?[2].tier, "fast")

        // Configured provider models carry no label and may be "vendor/model".
        XCTAssertEqual(claude.models?[3].displayLabel, "deepseek-v4-flash-0731")
        XCTAssertEqual(claude.models?[3].tier, "fast")

        // An agent that advertises no choices omits `models` entirely.
        XCTAssertNil(agents[1].models)
        XCTAssertEqual(agents[1].isDefault, true)
    }

    func testAgentModelOptionPrefersLabelThenLastPathSegment() {
        let option = AgentModelOption(id: "sonnet", label: nil, tier: nil)
        XCTAssertEqual(option.displayLabel, "sonnet")
        XCTAssertEqual(AgentModelOption(id: "sonnet", label: "  ", tier: nil).displayLabel, "sonnet")
        XCTAssertEqual(
            AgentModelOption(id: "anthropic/claude-sonnet-5", label: nil, tier: nil).displayLabel,
            "claude-sonnet-5"
        )
        // A trailing slash leaves no segment, so the id stands in for the label.
        XCTAssertEqual(
            AgentModelOption(id: "deepseek/v4/   ", label: nil, tier: nil).displayLabel,
            "deepseek/v4/"
        )
    }

    func testKinTaskDecodesDaemonPayload() throws {
        let task = try decode(KinTask.self, """
        {"id":"01M0SGDCVMMEE5NFH23BWVTFGH","status":"running","agent":"claude-code",
         "cwd":"/Users/dev/repo","prompt":"do the thing","permission_mode":"acceptEdits",
         "workspace_mode":"worktree","created_at":1767225600000,"started_at":1767225601000,
         "elapsed_seconds":12.5,"cost_usd":0.25,"session_ref":"sess-1"}
        """)
        XCTAssertEqual(task.id, "01M0SGDCVMMEE5NFH23BWVTFGH")
        XCTAssertEqual(task.status, .running)
        XCTAssertEqual(task.createdAt, 1767225600000)
        XCTAssertEqual(task.startedAt, 1767225601000)
        XCTAssertEqual(task.costUSD, 0.25)
        XCTAssertEqual(task.permissionMode, "acceptEdits")
        XCTAssertEqual(task.workspaceMode, "worktree")
        XCTAssertEqual(task.sessionRef, "sess-1")
    }

    func testApprovalDecodesDaemonPayload() throws {
        let approval = try decode(Approval.self, """
        {"id":"ap1","task_id":"t1","kind":"tool_use",
         "payload":{"tool_name":"Bash","input":{"command":"ls","description":"list files"}},
         "decision":"pending","created_at":1767225600000}
        """)
        XCTAssertEqual(approval.taskId, "t1")
        XCTAssertEqual(approval.status, .pending)
        XCTAssertEqual(approval.createdAt, 1767225600000)
        XCTAssertEqual(approval.toolName, "Bash")
        XCTAssertEqual(approval.command, "ls")
        XCTAssertEqual(approval.inputDetail, "list files")
    }

    func testTaskEventDecodesDaemonPayload() throws {
        let event = try decode(TaskEvent.self, """
        {"task_id":"t1","event_epoch":0,"seq":1,"ts":1767225600000,"type":"message",
         "payload":{"role":"user","content":"hi"}}
        """)
        XCTAssertEqual(event.taskId, "t1")
        XCTAssertEqual(event.eventEpoch, 0)
        XCTAssertEqual(event.seq, 1)
        XCTAssertEqual(event.ts, 1767225600000)
        XCTAssertEqual(event.eventType, "message")
    }

    func testWorkerRecordDecodesDaemonPayload() throws {
        let worker = try decode(WorkerRecord.self, """
        {"version":1,"worker_id":"w1","label":"mac","owner_device_id":"d1",
         "capabilities":[{"name":"shell","version":"1","features":["bash"]}],
         "max_concurrent":2,
         "lease":{"lease_id":"l1","worker_id":"w1","issued_at":10,"expires_at":20},
         "state":"active","last_seen_at":30}
        """)
        XCTAssertEqual(worker.workerId, "w1")
        XCTAssertEqual(worker.ownerDeviceId, "d1")
        XCTAssertEqual(worker.maxConcurrent, 2)
        XCTAssertEqual(worker.lastSeenAt, 30)
        XCTAssertEqual(worker.capabilities.count, 1)
        XCTAssertEqual(worker.lease.leaseId, "l1")
        XCTAssertEqual(worker.lease.expiresAt, 20)
    }

    func testWorkspaceDecodesDaemonPayload() throws {
        let workspaces = try decode([Workspace].self, """
        [{"id":"g1","task_id":"t1","generation":2,"state":"integrated",
          "source_root":"/Users/dev/repo","scope":".","created_at":1767225600000,
          "updated_at":1767225601000,"integrated_at":1767225602000}]
        """)
        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].id, "g1")
        XCTAssertEqual(workspaces[0].taskId, "t1")
        XCTAssertEqual(workspaces[0].generation, 2)
        XCTAssertEqual(workspaces[0].createdAt, 1767225600000)
    }

    func testServerMessageDecodesTaskUpdateWithAppDecoder() throws {
        let message = try decode(ServerMessage.self, """
        {"kind":"task_update","data":{"id":"t1","status":"running","agent":"kin",
         "cwd":"/tmp","prompt":"hello","created_at":1767225600000}}
        """)
        guard case .taskUpdate(let task) = message else { return XCTFail("Expected taskUpdate") }
        XCTAssertEqual(task.id, "t1")
        XCTAssertEqual(task.createdAt, 1767225600000)
    }

    private func makeTask(
        id: String = "t1",
        status: TaskStatus,
        prompt: String = "test",
        title: String? = nil,
        cwd: String = "/tmp",
        projectId: String? = nil,
        createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        startedAt: Int64? = nil,
        finishedAt: Int64? = nil
    ) -> KinTask {
        KinTask(
            id: id,
            status: status,
            agent: "kin",
            model: nil,
            cwd: cwd,
            projectId: projectId,
            prompt: prompt,
            title: title,
            permissionMode: nil,
            workspaceMode: nil,
            approvalIds: nil,
            questionIds: nil,
            createdAt: createdAt,
            startedAt: startedAt,
            finishedAt: finishedAt,
            elapsedSeconds: nil,
            costUSD: nil,
            sessionRef: nil,
            error: nil
        )
    }

    // MARK: - ServerMessage

    func testServerMessageDecodesTaskUpdate() throws {
        let message = try decode(ServerMessage.self, """
        {"kind": "task_update", "data": {"id": "t1", "status": "running", "agent": "kin", "cwd": "/tmp", "prompt": "hello", "created_at": 1767225600000}}
        """)
        guard case .taskUpdate(let task) = message else { return XCTFail("Expected taskUpdate") }
        XCTAssertEqual(task.id, "t1")
        XCTAssertEqual(task.status, .running)
    }

    func testServerMessageDecodesTaskDeleted() throws {
        let message = try decode(ServerMessage.self, """
        {"kind": "task_deleted", "data": {"id": "t1"}}
        """)
        guard case .taskDeleted(let id) = message else { return XCTFail("Expected taskDeleted") }
        XCTAssertEqual(id, "t1")
    }

    func testServerMessageDecodesCanonicalEventPayload() throws {
        let message = try decode(ServerMessage.self, """
        {"kind":"event","data":{"task_id":"t1","event_epoch":0,"seq":1,"ts":1767225600000,"type":"message","payload":{"role":"assistant","content":"hello"}}}
        """)
        guard case .event(let event) = message else { return XCTFail("Expected event") }
        XCTAssertEqual(event.taskId, "t1")
        XCTAssertEqual(
            event.content,
            .message(role: "assistant", text: "hello", speaker: "assistant", partial: false)
        )
    }

    // MARK: - Task transcript projection

    func testTaskEventDecodesStreamingMessageFields() throws {
        let message = try decode(ServerMessage.self, """
        {"kind":"event","data":{"task_id":"t1","event_epoch":0,"seq":3,"ts":1767225600000,"type":"message",
         "payload":{"role":"assistant","speaker":"kin","partial":true,"phase":"","visibility":{"task":"1"},
                    "content":[{"type":"text","text":"I am "}]}}}
        """)
        guard case .event(let event) = message else { return XCTFail("Expected event") }
        XCTAssertEqual(
            event.content,
            .message(role: "assistant", text: "I am ", speaker: "kin", partial: true)
        )
    }

    /// The daemon stores a turn as partial chunks and then the complete message,
    /// with `usage` and `raw_output` in between. Rendered one row per event that
    /// is the reported bug: every chunk its own bubble, the whole answer on top of
    /// them, and placeholder rows for the accounting events.
    func testTranscriptProjectionCoalescesStreamedChunks() {
        let events = [
            makeEvent(seq: 1, type: "message", payload: messagePayload(
                "What model are you?", role: "user", speaker: "user"
            )),
            makeEvent(seq: 2, type: "task_started", payload: ["model": "grok-4.7"]),
            makeEvent(seq: 3, type: "message", payload: messagePayload("I am ", partial: true)),
            makeEvent(seq: 4, type: "message", payload: messagePayload("Kin, a local ", partial: true)),
            makeEvent(seq: 5, type: "message", payload: messagePayload("coding agent.", partial: true)),
            makeEvent(seq: 6, type: "usage", payload: ["prompt_tokens": 1493]),
            makeEvent(seq: 7, type: "raw_output", payload: ["line": "no price entry"]),
            makeEvent(seq: 8, type: "message", payload: messagePayload(
                "I am Kin, a local coding agent.", phase: "summary"
            )),
            makeEvent(seq: 9, type: "result", payload: ["is_error": false]),
        ]

        let rows = EventProjection.rows(from: events)

        XCTAssertEqual(rows.map(\.primaryText), ["What model are you?", "I am Kin, a local coding agent."])
        XCTAssertEqual(rows.map(\.style), [.user, .agent])
        // The answer is the seq-8 message, not a row per chunk: seq 2, 6, 7 and 9
        // leave nothing behind and seq 3-5 collapse into the message that closed
        // them.
        XCTAssertEqual(rows.map(\.seq), [1, 8])
        XCTAssertEqual(rows.map(\.id), ["1-message", "8-message"])
    }

    func testTranscriptProjectionReplacesPreviewWithFinalMessage() {
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("Hel", partial: true)),
            makeEvent(seq: 2, type: "message", payload: messagePayload("Hello there")),
        ])
        XCTAssertEqual(rows.map(\.primaryText), ["Hello there"])
    }

    /// A run with no final message yet is the live answer: it shows what has
    /// arrived, folded into one row.
    func testTranscriptProjectionShowsUnfinishedStream() {
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("Hel", partial: true)),
            makeEvent(seq: 2, type: "message", payload: messagePayload("lo", partial: true)),
        ])
        XCTAssertEqual(rows.map(\.primaryText), ["Hello"])
        XCTAssertEqual(rows.map(\.id), ["1-message"])
    }

    func testTranscriptProjectionSeparatesSpeakers() {
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("one", speaker: "kin", partial: true)),
            makeEvent(seq: 2, type: "message", payload: messagePayload("two", speaker: "codex", partial: true)),
            makeEvent(seq: 3, type: "message", payload: messagePayload("three", speaker: "kin", partial: true)),
        ])
        XCTAssertEqual(rows.map(\.primaryText), ["one", "two", "three"])
    }

    /// A message's column follows the speaker, not the role: the adapter stamps
    /// tool echoes with role "user" while naming the agent that produced them,
    /// and the console shows those in the agent column too.
    func testTranscriptProjectionColumnsAgentEchoesBySpeaker() {
        let rows = EventProjection.rows(from: [
            makeEvent(
                seq: 1, type: "message",
                payload: messagePayload("why is the sky blue", role: "user", speaker: "user")
            ),
            makeEvent(
                seq: 2, type: "message",
                payload: messagePayload("Read(src/main.go)", role: "user", speaker: "claude-code")
            ),
            makeEvent(
                seq: 3, type: "message",
                payload: messagePayload("Rayleigh scattering.", speaker: "claude-code")
            ),
        ])
        XCTAssertEqual(rows.map(\.primaryText), [
            "why is the sky blue",
            "Read(src/main.go)",
            "Rayleigh scattering.",
        ])
        XCTAssertEqual(rows.map(\.style), [.user, .agent, .agent])
    }

    /// Events with nothing to say must not reach the transcript, and must not break
    /// a stream either: a tool result the adapter echoes back as an empty message
    /// arrives in the middle of one.
    func testTranscriptProjectionDropsEmptyMessagesAndPlumbing() {
        let events = [
            makeEvent(seq: 1, type: "message", payload: [
                "role": "user", "speaker": "claude-code", "partial": false,
                "content": [["type": "tool_result", "content": "file contents"]],
            ]),
            makeEvent(seq: 2, type: "message", payload: messagePayload("Hel", partial: true)),
            makeEvent(seq: 3, type: "approval_decided", payload: ["approval_id": "a1"]),
            makeEvent(seq: 4, type: "message", payload: messagePayload("lo", partial: true)),
        ]
        let rows = EventProjection.rows(from: events)
        XCTAssertEqual(rows.map(\.primaryText), ["Hello"])
    }

    func testTranscriptProjectionDropsBlankStreams() {
        XCTAssertTrue(EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload(" ", partial: true)),
            makeEvent(seq: 2, type: "message", payload: messagePayload("", partial: true)),
        ]).isEmpty)

        // A blank chunk in the middle does not split the run it belongs to.
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("Hel", partial: true)),
            makeEvent(seq: 2, type: "message", payload: messagePayload("", partial: true)),
            makeEvent(seq: 3, type: "message", payload: messagePayload("lo", partial: true)),
        ])
        XCTAssertEqual(rows.map(\.primaryText), ["Hello"])
    }

    /// A turn that streams, does tool work, streams again, and then closes with one
    /// complete message. The chunks before the tools were previews of that same
    /// message, so a row for them would repeat the answer.
    func testTranscriptProjectionTakesBackPreviewsAcrossToolWork() {
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("Let me look.", partial: true)),
            makeEvent(seq: 2, type: "tool_use", payload: ["name": "glob", "tool_use_id": "t1"]),
            makeEvent(seq: 3, type: "tool_result", payload: ["tool_use_id": "t1", "ok": true]),
            makeEvent(seq: 4, type: "message", payload: messagePayload("Found it.", partial: true)),
            makeEvent(seq: 5, type: "message", payload: messagePayload(
                "I looked and here is the answer.", phase: "summary"
            )),
        ])
        // Tool events still render as placeholders; only the message rows are
        // under test, and there is exactly one.
        let texts = rows.filter { $0.id.hasSuffix("-message") }.map(\.primaryText)
        XCTAssertEqual(texts, ["I looked and here is the answer."])
    }

    /// A preview stands on its own once a new user turn starts: nothing later can
    /// claim to supersede it.
    func testTranscriptProjectionKeepsPreviewsFromEarlierTurns() {
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("Streamed but never finished.", partial: true)),
            makeEvent(seq: 2, type: "message", payload: messagePayload("Next question", role: "user", speaker: "user")),
            makeEvent(seq: 3, type: "message", payload: messagePayload("The answer.")),
        ])
        let texts = rows.filter { $0.id.hasSuffix("-message") }.map(\.primaryText)
        XCTAssertEqual(texts, ["Streamed but never finished.", "Next question", "The answer."])
    }

    func testTranscriptProjectionKeepsVisibleRowsInOrder() {
        let events = [
            makeEvent(seq: 1, type: "message", payload: messagePayload("hi")),
            makeEvent(seq: 2, type: "error", payload: ["message": "boom"]),
            makeEvent(seq: 3, type: "message", payload: messagePayload("after")),
        ]
        let rows = EventProjection.rows(from: events)
        XCTAssertEqual(rows.map(\.seq), [1, 2, 3])
        XCTAssertEqual(rows.map(\.id), ["1-message", "2-error", "3-message"])
    }

    /// Only turns are bubbles; tool work, errors and approvals stay compact rows
    /// inside the transcript.
    func testTranscriptProjectionStylesNoticesSeparatelyFromTurns() {
        let rows = EventProjection.rows(from: [
            makeEvent(seq: 1, type: "message", payload: messagePayload("hi", role: "user", speaker: "user")),
            makeEvent(seq: 2, type: "tool_use", payload: ["name": "glob", "tool_use_id": "t1"]),
            makeEvent(seq: 3, type: "message", payload: messagePayload("Looking.")),
            makeEvent(seq: 4, type: "error", payload: ["message": "boom"]),
        ])
        XCTAssertEqual(rows.map(\.style), [.user, .notice, .agent, .notice])
    }

    /// A list row and a navigation title show the name the daemon gave the
    /// session, so a conversation is called the same thing on the phone as in the
    /// web console.
    func testTaskPresentationPrefersTheDaemonTitle() {
        let named = makeTask(
            status: .running,
            prompt: "Fix the flaky login test.\nIt fails one run in ten.",
            title: "Auth test flakiness"
        )
        XCTAssertEqual(TaskPresentation.summary(for: named).title, "Auth test flakiness")
        // What a row shows has to be searchable even when the daemon generated it
        // and the words appear nowhere in the prompt.
        XCTAssertEqual(TaskPresentation.filter([named], query: "flakiness"), [named])

        // A name the daemon left blank is not a name.
        let blank = makeTask(status: .running, prompt: "Fix the relay timeouts.", title: "   ")
        XCTAssertEqual(TaskPresentation.summary(for: blank).title, "Fix the relay timeouts.")
    }

    /// Rows written before the daemon started naming sessions fall back to the
    /// line that opened the chat; a search still reaches text further down.
    func testTaskPresentationTitlesFallBackToTheFirstPromptLine() {
        XCTAssertEqual(
            TaskPresentation.firstLine(of: "\n\n  Fix the relay timeouts.\nAnd the log noise."),
            "Fix the relay timeouts."
        )
        XCTAssertEqual(TaskPresentation.firstLine(of: "   \n \n"), "")

        let task = makeTask(
            status: .running,
            prompt: "Fix the relay timeouts.\nAlso the log noise."
        )
        XCTAssertEqual(TaskPresentation.summary(for: task).title, "Fix the relay timeouts.")
        XCTAssertEqual(TaskPresentation.filter([task], query: "log noise").count, 1)
    }

    /// The composer writes absolute upload paths into the prompt for the agent.
    /// Showing them would put the user's filesystem into a chat bubble and into
    /// the info sheet, so the paths give way to the names they point at — which is
    /// what the web console does with the same block.
    func testDisplayUserPromptStripsAttachmentPaths() {
        let prompt = """
        What is in this shot?

        Attached image:
        - shot.png: /Users/me/.kin/uploads/abc.png
        """

        XCTAssertEqual(
            TaskPresentation.displayUserPrompt(prompt),
            "What is in this shot?\n\nAttached image: shot.png"
        )
        XCTAssertFalse(TaskPresentation.displayUserPrompt(prompt).contains("/Users/me"))

        // A prompt that is nothing but an attachment still says what it carried.
        XCTAssertEqual(
            TaskPresentation.displayUserPrompt("Attached files:\n- a.txt: /tmp/a.txt\n"),
            "Attached files: a.txt"
        )
        XCTAssertEqual(
            TaskPresentation.stripAttachmentBlock("Attached files:\n- a.txt: /tmp/a.txt\n"),
            ""
        )

        // Text without an attachment block is left exactly as it was written.
        XCTAssertEqual(TaskPresentation.displayUserPrompt("just a question"), "just a question")
    }

    /// An attachment-only prompt names its chat after the file, not after the
    /// "Attached files:" header.
    func testTaskTitleIgnoresAttachmentPathBlocks() {
        let task = makeTask(
            status: .running,
            prompt: "Attached image:\n- shot.png: /Users/me/.kin/uploads/abc.png\n"
        )
        XCTAssertEqual(TaskPresentation.summary(for: task).title, "Attached image: shot.png")
    }

    // MARK: - APIClient request shape

    /// Sending a message into a task is the one call the daemon is picky about:
    /// `POST /api/tasks/{id}/prompt` decodes `task.FollowUpRequest`, whose field
    /// is `prompt`. A body keyed `message` decodes to an empty prompt and the
    /// daemon answers 400 "prompt is required" — which is what the app used to
    /// send, so guidance from the phone failed every time.
    func testPromptTaskSendsThePromptFieldName() async throws {
        RecordingURLProtocol.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingURLProtocol.self]
        let client = APIClient(
            baseURL: URL(string: "http://127.0.0.1:7777")!,
            token: "test-token",
            session: URLSession(configuration: configuration)
        )

        try await client.promptTask(id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", message: "also fix the logs")

        let request = try XCTUnwrap(RecordingURLProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.path, "/api/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/prompt")
        let body = try XCTUnwrap(request.body, "the request carried no body")
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any],
            "body was not a JSON object: \(String(decoding: body, as: UTF8.self))"
        )
        XCTAssertEqual(json.count, 1, "unexpected extra fields: \(json.keys.sorted())")
        XCTAssertEqual(json["prompt"] as? String, "also fix the logs")
    }

    /// The daemon lists approvals of *every* decision unless it is asked to
    /// filter, so a client that asks for nothing counts decided approvals as
    /// pending — badging chats, and offering decisions that were already made.
    func testPendingCollectionsAskTheDaemonToFilter() async throws {
        RecordingURLProtocol.requests = []
        RecordingURLProtocol.responseBody = Data("[]".utf8)
        defer { RecordingURLProtocol.responseBody = Data("{}".utf8) }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingURLProtocol.self]
        let client = APIClient(
            baseURL: URL(string: "http://127.0.0.1:7777")!,
            token: "test-token",
            session: URLSession(configuration: configuration)
        )

        _ = try await client.approvals()
        _ = try await client.userQuestions()

        XCTAssertEqual(RecordingURLProtocol.requests.map(\.url.path), ["/api/approvals", "/api/user-questions"])
        for request in RecordingURLProtocol.requests {
            let items = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(
                items?.first { $0.name == "status" }?.value,
                "pending",
                "\(request.url.path) did not ask for pending rows only"
            )
        }
    }

    /// A rejected request shows what the daemon said, not just the status code —
    /// "prompt is required (400)" is a bug report; "Request error (400)" is not.
    func testClientErrorCarriesTheDaemonMessage() {
        XCTAssertEqual(
            APIError.clientError(400, "prompt is required").errorDescription,
            "prompt is required (400)"
        )
        XCTAssertEqual(
            APIError.clientError(400, nil).errorDescription,
            "Request error (400)"
        )
    }

    private func makeEvent(seq: Int, type: String, payload: [String: Any]) -> TaskEvent {
        TaskEvent(
            taskId: "t1",
            eventEpoch: 0,
            seq: seq,
            ts: 1_767_225_600_000 + seq,
            eventType: type,
            payloadData: try? JSONSerialization.data(withJSONObject: payload)
        )
    }

    private func messagePayload(
        _ text: String,
        role: String = "assistant",
        speaker: String = "kin",
        partial: Bool = false,
        phase: String = ""
    ) -> [String: Any] {
        [
            "role": role,
            "speaker": speaker,
            "partial": partial,
            "phase": phase,
            "content": [["type": "text", "text": text]],
        ]
    }

    func testServerMessageDecodesUnknownType() throws {
        let message = try decode(ServerMessage.self, """
        {"kind": "future_event", "data": {"some": "data"}}
        """)
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

    func testConnectionBannerSuppressesTransientConnectionStates() {
        XCTAssertFalse(ConnectionBannerPresentation.shouldRender(.connecting, isDelayedVisible: false))
        XCTAssertFalse(ConnectionBannerPresentation.shouldRender(.reconnecting(delay: 1), isDelayedVisible: false))
        XCTAssertFalse(ConnectionBannerPresentation.shouldRender(.reconnecting(delay: 10), isDelayedVisible: true))
    }

    func testConnectionBannerDelaysOfflineState() {
        XCTAssertEqual(ConnectionBannerPresentation.displayDelay(for: .offline("Disconnected")), 30)
        XCTAssertFalse(ConnectionBannerPresentation.shouldRender(.offline("Disconnected"), isDelayedVisible: false))
        XCTAssertTrue(ConnectionBannerPresentation.shouldRender(.offline("Disconnected"), isDelayedVisible: true))
    }

    func testConnectionBannerKeepsOfflineDelayAcrossMessageChanges() {
        XCTAssertEqual(
            ConnectionBannerPresentation.identity(for: .offline("Disconnected")),
            ConnectionBannerPresentation.identity(for: .offline("Cannot reach daemon"))
        )
    }

    func testConnectionBannerShowsActionableFailuresImmediately() {
        XCTAssertTrue(ConnectionBannerPresentation.shouldRender(.unauthorized, isDelayedVisible: false))
        XCTAssertTrue(ConnectionBannerPresentation.shouldRender(.incompatible, isDelayedVisible: false))
        XCTAssertFalse(ConnectionBannerPresentation.shouldRender(.connected, isDelayedVisible: true))
        XCTAssertFalse(ConnectionBannerPresentation.shouldRender(.unconfigured, isDelayedVisible: true))
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

    func testServerProfilePresentationUsesDesktopIdentitySuffix() throws {
        let profile = ServerProfile(
            id: UUID(),
            displayName: "relay.example.com",
            baseURL: try XCTUnwrap(URL(string: "https://relay.example.com")),
            relayKey: "relay-key",
            relayRoom: "room",
            dateAdded: Date(timeIntervalSince1970: 1),
            lastAccessed: Date(timeIntervalSince1970: 1),
            desktopID: "desktop_1234abcd5678",
            desktopName: "Work Mac"
        )

        XCTAssertEqual(profile.activeDesktopName, "Work Mac · 1234")
    }

    func testServerProfileDecodesLegacyProfileWithoutDesktopIdentity() throws {
        let data = """
        {
          "id": "00000000-0000-0000-0000-000000000001",
          "displayName": "Legacy Mac",
          "baseURL": "https://relay.example.test",
          "dateAdded": 1,
          "lastAccessed": 2,
          "credentialScope": "device"
        }
        """.data(using: .utf8)!

        let profile = try JSONDecoder().decode(ServerProfile.self, from: data)

        XCTAssertNil(profile.desktopID)
        XCTAssertNil(profile.desktopName)
        XCTAssertEqual(profile.activeDesktopName, "Legacy Mac")
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

    // MARK: - Bundle metadata

    /// CFNetwork builds the default User-Agent from `CFBundleVersion` and hands the
    /// value straight to `CFURLCreateStringByAddingPercentEscapes`, which sends
    /// `-length`. A non-string value (e.g. `<integer>1</integer>`) aborts the process
    /// on the first HTTP request with `-[__NSCFNumber length]: unrecognized selector`.
    func testBundleVersionIsString() throws {
        let value = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion"))
        XCTAssertTrue(value is String, "CFBundleVersion must be a string, got \(type(of: value))")
    }
}

/// Records what an `APIClient` actually puts on the wire and answers 200, so a
/// request-body contract can be asserted without a daemon.
final class RecordingURLProtocol: URLProtocol {
    struct Request {
        let url: URL
        let method: String
        let body: Data?
    }

    static var requests: [Request] = []
    /// What every recorded request answers with. Defaults to an empty object,
    /// which is enough for the calls whose response the test ignores.
    static var responseBody = Data("{}".utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url ?? URL(string: "about:blank")!
        // URLSession moves the body into `httpBodyStream` before the protocol
        // sees it, and reading it consumes it, so capture what is there.
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            body = Self.drain(stream)
        }
        Self.requests.append(
            Request(url: url, method: request.httpMethod ?? "", body: body)
        )

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
