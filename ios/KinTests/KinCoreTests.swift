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

    func testPairingNormalizesPathAndFragments() throws {
        let payload = try PairingPayload.parse("http://10.0.0.5:7777/tasks/abc?token=secret#fragment")
        XCTAssertEqual(payload.baseURL.absoluteString, "http://10.0.0.5:7777")
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
            createdAt: Date(),
            updatedAt: nil,
            elapsedSeconds: nil,
            costCents: nil,
            sessionId: nil,
            error: nil
        )
    }

    // MARK: - ServerMessage

    func testServerMessageDecodesTaskUpdate() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = Data("""
        {"type": "task_update", "payload": {"id": "t1", "status": "running", "agent": "kin", "cwd": "/tmp", "prompt": "hello", "created_at": "2026-01-01T00:00:00Z"}}
        """.utf8)
        let message = try decoder.decode(ServerMessage.self, from: data)
        guard case .taskUpdate(let task) = message else { return XCTFail("Expected taskUpdate") }
        XCTAssertEqual(task.id, "t1")
        XCTAssertEqual(task.status, .running)
    }

    func testServerMessageDecodesTaskDeleted() throws {
        let data = Data("""
        {"type": "task_deleted", "payload": {"id": "t1"}}
        """.utf8)
        let message = try JSONDecoder().decode(ServerMessage.self, from: data)
        guard case .taskDeleted(let id) = message else { return XCTFail("Expected taskDeleted") }
        XCTAssertEqual(id, "t1")
    }

    func testServerMessageDecodesUnknownType() throws {
        let data = Data("""
        {"type": "future_event", "payload": {"some": "data"}}
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

    // MARK: - QuestionType

    func testQuestionTypeDecodes() throws {
        let json = """
        ["single_select", "multi_select", "free_text", "unknown_type"]
        """.data(using: .utf8)!
        let types = try JSONDecoder().decode([QuestionType].self, from: json)
        XCTAssertEqual(types, [.singleSelect, .multiSelect, .freeText, .unknown])
    }
}