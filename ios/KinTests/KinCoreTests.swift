import XCTest
@testable import Kin

final class KinCoreTests: XCTestCase {
    func testPairingParsesLANURLAndRemovesSecretFromProfile() throws {
        let credentials = try PairingPayload.parse(
            connectionURL: "http://192.168.1.20:7777/tasks/abc?token=secret#event"
        )

        XCTAssertEqual(credentials.profile.baseURL.absoluteString, "http://192.168.1.20:7777")
        XCTAssertEqual(credentials.profile.displayName, "192.168.1.20")
        XCTAssertEqual(credentials.token, "secret")
        XCTAssertFalse(String(describing: credentials.profile).contains("secret"))
    }

    func testPairingAcceptsTailnetAndRejectsPublicHTTP() throws {
        XCTAssertNoThrow(
            try PairingPayload.parse(
                connectionURL: "http://100.90.10.2:7777/?token=tailnet"
            )
        )
        XCTAssertThrowsError(
            try PairingPayload.parse(
                connectionURL: "http://example.com/?token=unsafe"
            )
        ) { error in
            XCTAssertEqual(error as? PairingError, .insecurePublicHost)
        }
    }

    func testServerMessageDecodesTaskEvent() throws {
        let data = Data(
            """
            {
              "kind": "event",
              "data": {
                "task_id": "t1",
                "event_epoch": 2,
                "seq": 4,
                "ts": 1000,
                "type": "message",
                "payload": {"speaker": "kin", "content": "Working"}
              }
            }
            """.utf8
        )
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let message = try decoder.decode(ServerMessage.self, from: data)
        guard case let .event(event) = message else {
            return XCTFail("Expected event")
        }
        XCTAssertEqual(event.taskId, "t1")
        XCTAssertEqual(event.eventEpoch, 2)
        XCTAssertEqual(event.seq, 4)
        XCTAssertEqual(event.payload["content"]?.stringValue, "Working")
    }

    func testQuestionPayloadSupportsMultipleSelection() throws {
        let data = Data(
            """
            {
              "question": "Which checks?",
              "header": "Tests",
              "multi_select": true,
              "options": [
                {"label": "Unit", "description": "Fast"},
                {"label": "E2E"}
              ]
            }
            """.utf8
        )
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        let payload = QuestionPayload(json: value)

        XCTAssertEqual(payload.question, "Which checks?")
        XCTAssertEqual(payload.header, "Tests")
        XCTAssertTrue(payload.multiSelect)
        XCTAssertEqual(payload.options.map(\.label), ["Unit", "E2E"])
    }

    func testEventPresentationDegradesUnknownEvent() throws {
        let event = TaskEvent(
            taskId: "t1",
            eventEpoch: 1,
            seq: 2,
            ts: 1000,
            type: "future_protocol_event",
            payload: .object(["message": .string("still readable")])
        )
        let presentation = EventPresentation(event: event)

        XCTAssertEqual(presentation.title, "Future Protocol Event")
        XCTAssertEqual(presentation.body, "still readable")
    }
}
