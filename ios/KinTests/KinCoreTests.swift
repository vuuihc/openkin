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
