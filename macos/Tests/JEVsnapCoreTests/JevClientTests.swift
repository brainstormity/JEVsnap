import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import JEVsnapCore

final class JevClientTests: XCTestCase {
    func testRequestShapeAndHeaders() async throws {
        let t = MockTransport { _, _ in ok(["q": ["type": "noul", "noul": 0.9]]) }
        let client = makeClient(t)
        let resp = try await client.systemOne(JevRequest(
            model: "jev-latest", state: "hello",
            questions: ["q": Question.noul("Is it?", criteria: ["true": "yes", "false": "no"])]))

        XCTAssertEqual(resp.answers["q"], .noul(0.9))
        XCTAssertEqual(resp.inputTokens, 10)
        let r = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.url?.absoluteString, "https://api.example.test/v1/systemone")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer test-key-123")
        XCTAssertNil(r.value(forHTTPHeaderField: "TypeSafe-Danger-Zone-Images"), "text-only requests must not opt in to the danger zone")
        let body = requestJSON(r)
        XCTAssertEqual(body["model"], "jev-latest")
        XCTAssertEqual(body["questions"]?["q"]?["type"], "noul")
        XCTAssertNil(body["assets"])
    }

    func testBoxAndImagesSendDangerZoneHeader() async throws {
        let t = MockTransport { _, _ in
            ok(["m": ["type": "box", "box": ["top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84], "confidence": 0.92]])
        }
        let resp = try await makeClient(t).systemOne(JevRequest(
            model: "jev-preview", state: ["photo": "ref-1"],
            questions: ["m": Question.box("the mug in `photo`")],
            assets: ["ref-1": ["type": "image", "format": "jpg", "data_base64": "AAAA"]]))

        XCTAssertEqual(t.requests.first?.value(forHTTPHeaderField: "TypeSafe-Danger-Zone-Images"), "true")
        XCTAssertEqual(resp.answers["m"], .box(NormRect(left: 0.44, top: 0.25, right: 0.84, bottom: 0.82), confidence: 0.92))
        XCTAssertEqual(requestJSON(t.requests[0])["assets"]?["ref-1"]?["format"], "jpg")
    }

    func testBoxQuestionAloneTriggersHeader() async throws {
        let t = MockTransport { _, _ in ok(["b": ["type": "box", "box": ["top": 0.1, "bottom": 0.3, "left": 0.2, "right": 0.4], "confidence": 0.9]]) }
        _ = try await makeClient(t).systemOne(JevRequest(model: "jev-preview", state: "x", questions: ["b": Question.box("a")]))
        XCTAssertEqual(t.requests.first?.value(forHTTPHeaderField: "TypeSafe-Danger-Zone-Images"), "true")
    }

    func testInvalidBoxIsUnknown() {
        let bad: JSONValue = ["type": "box", "box": ["top": 0.5, "bottom": 0.2, "left": 0.1, "right": 0.3], "confidence": 0.9]
        XCTAssertEqual(JevClient.parseAnswer(bad), .unknown)
    }

    func testChoiceAndScoreParsing() {
        let c: JSONValue = ["type": "choice", "choice": "one", "probabilities": ["none": 0.1, "one": 0.9], "confidence": 0.8]
        XCTAssertEqual(JevClient.parseAnswer(c), .choice("one", probabilities: ["none": 0.1, "one": 0.9], confidence: 0.8))
        let s: JSONValue = ["type": "score", "score": 1.5, "confidence": 0.7]
        XCTAssertEqual(JevClient.parseAnswer(s), .score(1.5, confidence: 0.7))
    }

    func testRetriesOn429ThenSucceeds() async throws {
        let t = MockTransport { _, n in
            n < 3 ? (429, Data("{}".utf8), ["Retry-After": "0"]) : ok(["q": ["type": "noul", "noul": 0.1]])
        }
        let resp = try await makeClient(t).systemOne(JevRequest(model: "m", state: "s", questions: ["q": Question.noul("?")]))
        XCTAssertEqual(resp.answers["q"], .noul(0.1))
        XCTAssertEqual(t.requests.count, 3)
    }

    func testGivesUpAfterMaxRetries() async {
        let t = MockTransport { _, _ in (529, Data("{}".utf8), [:]) }
        do {
            _ = try await makeClient(t, retries: 2).systemOne(JevRequest(model: "m", state: "s", questions: [:]))
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? JevError, .overloaded)
            XCTAssertEqual(t.requests.count, 3)   // 1 try + 2 retries
        }
    }

    func testDoesNotRetryClientErrors() async {
        let t = MockTransport { _, _ in (401, jsonData(["error": ["message": "bad key"]]), [:]) }
        do {
            _ = try await makeClient(t).systemOne(JevRequest(model: "m", state: "s", questions: [:]))
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? JevError, .unauthorized)
            XCTAssertEqual(t.requests.count, 1)
        }
    }

    func testBadRequestSurfacesServerMessageButNeverTheKey() async {
        let t = MockTransport { _, _ in (422, jsonData(["error": ["message": "questions.q.type is invalid"]]), [:]) }
        do {
            _ = try await makeClient(t, key: "SECRET-KEY-XYZ").systemOne(JevRequest(model: "m", state: "s", questions: [:]))
            XCTFail("expected throw")
        } catch {
            let msg = error.localizedDescription
            XCTAssertTrue(msg.contains("rejected the request"))
            XCTAssertFalse(msg.contains("SECRET-KEY-XYZ"))
        }
    }

    func testParsesRealWorldErrorShape() async {
        // Shape returned by api.typesafe.ai for a rejected key.
        let body = jsonData(["detail": ["error_type": "authentication_error", "message": "Cannot authenticate with the server."]])
        XCTAssertEqual(JevClient.errorMessage(from: body), "Cannot authenticate with the server.")
        let t = MockTransport { _, _ in (422, body, [:]) }
        do {
            _ = try await makeClient(t).systemOne(JevRequest(model: "m", state: "s", questions: [:]))
            XCTFail("expected throw")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("rejected the request"))
        }
    }

    func testConstructorValidation() {
        XCTAssertThrowsError(try JevClient(apiKey: "  ")) { XCTAssertEqual($0 as? JevError, .missingAPIKey) }
        XCTAssertThrowsError(try JevClient(apiKey: "k", baseURL: "http://api.typesafe.ai")) { XCTAssertEqual($0 as? JevError, .insecureBaseURL) }
        XCTAssertThrowsError(try JevClient(apiKey: "bad\nkey")) 
        XCTAssertNoThrow(try JevClient(apiKey: "k", baseURL: "http://localhost:8080"))
        XCTAssertNoThrow(try JevClient(apiKey: " k \n"))
    }

    func testListModels() async throws {
        let t = MockTransport { _, _ in
            (200, jsonData(["models": [["name": "jev-latest", "description": "d", "release_date": "x"], ["name": "jev-preview"]]]), [:])
        }
        let names = try await makeClient(t).listModels()
        XCTAssertEqual(names, ["jev-latest", "jev-preview"])
        XCTAssertEqual(t.requests.first?.httpMethod, "GET")
        XCTAssertEqual(t.requests.first?.url?.path, "/v1/models")
    }

    func testMalformedResponse() async {
        let t = MockTransport { _, _ in (200, Data("not json".utf8), [:]) }
        do {
            _ = try await makeClient(t).systemOne(JevRequest(model: "m", state: "s", questions: [:]))
            XCTFail("expected throw")
        } catch {
            guard case .invalidResponse? = error as? JevError else { return XCTFail("wrong error \(error)") }
        }
    }
}
