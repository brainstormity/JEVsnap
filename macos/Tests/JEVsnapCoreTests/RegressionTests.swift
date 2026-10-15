import XCTest
@testable import JEVsnapCore

final class RegressionTests: XCTestCase {
    private var input: AnalysisInput {
        AnalysisInput(lines: [line("Owner: Jane Doe", row: 0)], imageWidth: 1000, imageHeight: 1000)
    }

    func testRequiredChecksRejectMissingKeysAndUnavailableImages() async {
        var settings = AppSettings()
        settings.abortIfAIUnavailable = true
        do {
            _ = try await RedactionEngine(settings: settings, client: nil).analyze(input)
            XCTFail("missing key must abort")
        } catch { XCTAssertEqual(error as? JevError, .missingAPIKey) }
        settings.aiEnabled = false
        settings.visualEnabled = true
        for hasProvider in [false, true] {
            var imageInput = input
            if hasProvider { imageInput.imageProvider = { _ in nil } }
            do {
                _ = try await RedactionEngine(settings: settings, client: makeClient(MockTransport { _, _ in ok([:]) })).analyze(imageInput)
                XCTFail("unavailable visual image must abort")
            } catch { XCTAssertNotNil(error as? JevError) }
        }
    }

    func testIncompleteAndInvalidAnswersFailClosed() async throws {
        for answers: [String: JSONValue] in [[:], ["L0": ["type": "noul", "noul": 2]], ["L0": ["type": "score", "score": 1, "confidence": 1]]] {
            let client = makeClient(MockTransport { _, _ in ok(answers) })
            var settings = AppSettings()
            settings.abortIfAIUnavailable = true
            do {
                _ = try await RedactionEngine(settings: settings, client: client).analyze(input)
                XCTFail("invalid answers must abort")
            } catch { XCTAssertNotNil(error as? JevError) }
            settings.abortIfAIUnavailable = false
            let result = try await RedactionEngine(settings: settings, client: client).analyze(input)
            XCTAssertFalse(result.aiRan)
            XCTAssertTrue(result.warnings.contains { $0.contains("invalid answers") })
        }
    }

    func testPrivateKeyBodyIsMaskedBeforeUpload() async throws {
        let body = "shortBase64WithoutDigits"
        let texts = ["-----BEGIN PRIVATE KEY-----", body, "-----END PRIVATE KEY-----", "ordinary text"]
        let transport = MockTransport { request, _ in
            let questions = requestJSON(request)["questions"]?.objectValue ?? [:]
            return ok(questions.mapValues { _ in ["type": "noul", "noul": 0.01] })
        }
        let inp = AnalysisInput(lines: texts.enumerated().map { line($1, row: $0) }, imageWidth: 1000, imageHeight: 1000)
        let result = try await RedactionEngine(settings: AppSettings(), client: makeClient(transport)).analyze(inp)
        XCTAssertEqual(result.findings.filter { $0.category == "Private key material" }.count, 3)
        XCTAssertFalse(transport.requests.isEmpty)
        for request in transport.requests {
            XCTAssertFalse(String(decoding: request.httpBody ?? Data(), as: UTF8.self).contains(body))
        }
    }

    func testSettingsAndUntrustedUsageCannotOverflow() throws {
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"requestTimeoutSeconds":1e200,"paddingPixels":-10,"aiThreshold":3}"#.utf8))
        XCTAssertEqual(settings.requestTimeoutSeconds, 300)
        XCTAssertEqual(settings.paddingPixels, 0)
        XCTAssertEqual(settings.aiThreshold, 0.99)
        let result = try JevClient.parseResponse(Data(#"{"answers":{},"usage":{"input_tokens":1e200,"output_tokens":0.5}}"#.utf8))
        XCTAssertNil(result.inputTokens)
        XCTAssertNil(result.outputTokens)
    }

    func testInvalidProbabilitiesAndSafeFallbackGeometry() {
        for value in [-1.0, 2, Double.infinity, Double.nan] {
            XCTAssertEqual(JevClient.parseAnswer(["type": "noul", "noul": .number(value)]), .unknown)
        }
        let line = OCRLine(text: "iiiiWWW", rect: NormRect(left: 0.1, top: 0.1, right: 0.9, bottom: 0.2))
        XCTAssertEqual(line.rect(for: NSRange(location: 4, length: 3)), line.rect)
        XCTAssertEqual(ImageLimits.targetSize(width: 1568, height: 260)?.height, 260)
    }

    func testRemoteErrorCannotExposeScreenshotContents() async {
        let client = makeClient(MockTransport { _, _ in
            (422, jsonData(["detail": ["message": "Private screenshot test-key-123"]]), [:])
        })
        do {
            _ = try await client.listModels()
            XCTFail("expected rejection")
        } catch {
            XCTAssertFalse(error.localizedDescription.contains("Private screenshot"))
            XCTAssertFalse(error.localizedDescription.contains("test-key-123"))
        }
    }
    func testMostlyMaskedLineStillChecksRemainingSensitiveText() async throws {
        let email = String(repeating: "a", count: 100) + "@example.com"
        let transport = MockTransport { request, _ in
            XCTAssertFalse(String(decoding: request.httpBody!, as: UTF8.self).contains(email))
            return ok(["L0": ["type": "noul", "noul": 0.99]])
        }
        let inp = AnalysisInput(lines: [line(email + " Jane Doe", row: 0)], imageWidth: 1000, imageHeight: 1000)
        let result = try await RedactionEngine(settings: AppSettings(), client: makeClient(transport)).analyze(inp)
        XCTAssertTrue(result.findings.contains { $0.source == .ai })
    }

}
