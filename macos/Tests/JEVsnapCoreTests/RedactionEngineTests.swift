import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import JEVsnapCore

/// Fake Jev: flags any line containing "Jane Doe" (p=0.95), everything else p=0.05.
private func fakeJev(_ req: URLRequest, _ n: Int) -> (status: Int, body: Data, headers: [String: String]) {
    let body = requestJSON(req)
    let screen = body["state"]?["screen"]?.objectValue ?? [:]
    var answers: [String: JSONValue] = [:]
    for id in body["questions"]?.objectValue?.keys.sorted() ?? [] {
        let text = screen[id]?.stringValue ?? ""
        let word = body["state"]?["words"]?[id]?["text"]?.stringValue
        let sensitive = word.map { ["Jane", "Doe", "Andy"].contains($0) } ?? text.contains("Jane Doe")
        answers[id] = ["type": "noul", "noul": .number(sensitive ? 0.95 : 0.05)]
    }
    return ok(answers)
}

final class RedactionEngineTests: XCTestCase {
    private func input(_ texts: [String]) -> AnalysisInput {
        AnalysisInput(lines: texts.enumerated().map { line($1, row: $0, of: max(20, texts.count)) },
                      imageWidth: 2000, imageHeight: 1000)
    }

    func testLocalRulesWorkWithoutAPIKey() async throws {
        let engine = RedactionEngine(settings: AppSettings(), client: nil)
        let r = try await engine.analyze(input(["hello", "mail bob@example.com please", "bye"]))
        XCTAssertEqual(r.findings.count, 1)
        XCTAssertEqual(r.findings[0].source, .rule)
        XCTAssertFalse(r.aiRan)
        XCTAssertTrue(r.warnings.contains { $0.contains("No API key") })
        XCTAssertEqual(r.rects.count, 1)
        // Only the email's span is covered, not the whole line.
        XCTAssertLessThan(r.rects[0].width, 0.8 * 0.6)
    }

    func testAILocatesSensitiveWordsAndMasksSecretsBeforeSending() async throws {
        let t = MockTransport(handler: fakeJev)
        let engine = RedactionEngine(settings: AppSettings(), client: makeClient(t))
        let secret = "sk_" + "live_" + "abcdefghijklmnop1234"
        let r = try await engine.analyze(input(["Dashboard", "Owner: Jane Doe", "STRIPE=\(secret)", "Settings"]))

        XCTAssertTrue(r.aiRan)
        let ai = r.findings.filter { $0.source == .ai }
        XCTAssertEqual(ai.count, 1)
        XCTAssertEqual(ai[0].category, RedactionEngine.aiCategory)
        XCTAssertTrue(r.findings.contains { $0.source == .rule })

        // The secret must never appear in anything sent to the API.
        for req in t.requests {
            let raw = String(decoding: req.httpBody ?? Data(), as: UTF8.self)
            XCTAssertFalse(raw.contains(secret), "secret leaked into request")
            if requestJSON(req)["state"]?["words"] == nil { XCTAssertTrue(raw.contains("[HIDDEN]")) }
            XCTAssertNil(req.value(forHTTPHeaderField: "TypeSafe-Danger-Zone-Images"))
        }
    }

    func testThresholdControlsSensitivity() async throws {
        var s = AppSettings()
        s.aiThreshold = 0.99
        let engine = RedactionEngine(settings: s, client: makeClient(MockTransport(handler: fakeJev)))
        let r = try await engine.analyze(input(["Owner: Jane Doe"]))
        XCTAssertTrue(r.findings.filter { $0.source == .ai }.isEmpty)
    }

    func testChunkingCoversEveryLineAndUsesContextWindows() async throws {
        let texts = (0..<95).map { $0 == 77 ? "Owner: Jane Doe" : "plain text line number \($0)" }
        let t = MockTransport(handler: fakeJev)
        let engine = RedactionEngine(settings: AppSettings(), client: makeClient(t))
        let r = try await engine.analyze(input(texts))

        let lineRequests = t.requests.filter { requestJSON($0)["state"]?["words"] == nil }
        XCTAssertEqual(lineRequests.count, 3)   // 40 + 40 + 15 lines, followed by word localization
        XCTAssertEqual(r.findings.filter { $0.source == .ai }.count, 1)
        let asked = lineRequests.flatMap { requestJSON($0)["questions"]?.objectValue?.keys.map { String($0) } ?? [] }
        XCTAssertEqual(Set(asked).count, 95)
        // Each request's state carries a few context lines beyond the lines it asks about.
        for req in lineRequests {
            let b = requestJSON(req)
            let questionKeys = Set(b["questions"]?.objectValue?.keys.map { String($0) } ?? [])
            let stateKeys = Set(b["state"]?["screen"]?.objectValue?.keys.map { String($0) } ?? [])
            XCTAssertTrue(questionKeys.isSubset(of: stateKeys))
            XCTAssertGreaterThan(stateKeys.count, questionKeys.count)
        }
    }

    func testAIFailureFallsBackToLocalByDefault() async throws {
        let t = MockTransport { _, _ in (401, Data("{}".utf8), [:]) }
        let engine = RedactionEngine(settings: AppSettings(), client: makeClient(t))
        let r = try await engine.analyze(input(["mail bob@example.com"]))
        XCTAssertFalse(r.aiRan)
        XCTAssertEqual(r.findings.count, 1)
        XCTAssertTrue(r.warnings.contains { $0.contains("AI check unavailable") })
    }

    func testAIFailureAbortsWhenConfigured() async {
        var s = AppSettings()
        s.abortIfAIUnavailable = true
        let t = MockTransport { _, _ in (401, Data("{}".utf8), [:]) }
        let engine = RedactionEngine(settings: s, client: makeClient(t))
        do {
            _ = try await engine.analyze(input(["hello world"]))
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? JevError, .unauthorized)
        }
    }

    func testFullyCoveredAndBlankLinesAreNotSent() async throws {
        let t = MockTransport(handler: fakeJev)
        let engine = RedactionEngine(settings: AppSettings(), client: makeClient(t))
        _ = try await engine.analyze(input(["bob@example.com", "—", "real words here"]))
        let asked = t.requests.flatMap { requestJSON($0)["questions"]?.objectValue?.keys.map { String($0) } ?? [] }
        XCTAssertEqual(asked.count, 1)   // only "real words here"
    }

    func testAIDisabledSendsNothing() async throws {
        var s = AppSettings()
        s.aiEnabled = false
        let t = MockTransport(handler: fakeJev)
        let r = try await RedactionEngine(settings: s, client: makeClient(t)).analyze(input(["Owner: Jane Doe"]))
        XCTAssertTrue(t.requests.isEmpty)
        XCTAssertTrue(r.findings.isEmpty)
    }

    func testVisualPassUsesBoxWithGatingAndSkipsLowConfidence() async throws {
        var s = AppSettings()
        s.aiEnabled = false
        s.visualEnabled = true
        s.visualTargetsText = "a face\na signature"
        s.visualMinConfidence = 0.6
        let t = MockTransport { req, _ in
            ok([
                "seen0": ["type": "noul", "noul": 0.9],
                "box0": ["type": "box", "box": ["top": 0.1, "bottom": 0.3, "left": 0.2, "right": 0.4], "confidence": 0.9],
                "count0": ["type": "choice", "choice": "several", "probabilities": ["several": 0.9], "confidence": 0.9],
                "seen1": ["type": "noul", "noul": 0.9],
                "box1": ["type": "box", "box": ["top": 0.5, "bottom": 0.6, "left": 0.5, "right": 0.7], "confidence": 0.3],
                "count1": ["type": "choice", "choice": "one", "probabilities": ["one": 0.9], "confidence": 0.9],
            ])
        }
        var providerSaw: [NormRect] = []
        var inp = AnalysisInput(lines: [line("mail bob@example.com", row: 0)], imageWidth: 2000, imageHeight: 1000)
        inp.imageProvider = { rects in providerSaw = rects; return ImagePayload(data: Data([1, 2, 3]), format: "jpg") }
        let r = try await RedactionEngine(settings: s, client: makeClient(t)).analyze(inp)

        XCTAssertTrue(r.visualRan)
        XCTAssertEqual(providerSaw.count, 1, "image provider must receive earlier findings to black out first")
        XCTAssertEqual(r.findings.filter { $0.source == .visual }.count, 1)
        XCTAssertTrue(r.warnings.contains { $0.contains("More than one match") })
        let req = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(req.value(forHTTPHeaderField: "TypeSafe-Danger-Zone-Images"), "true")
        let body = requestJSON(req)
        XCTAssertEqual(body["model"], "jev-preview")
        XCTAssertEqual(body["assets"]?.objectValue?.count, 1)
        XCTAssertEqual(body["questions"]?["box0"]?["type"], "box")
    }

    func testVisualSkippedWhenImageOutOfLimits() async throws {
        var s = AppSettings()
        s.aiEnabled = false
        s.visualEnabled = true
        let t = MockTransport { _, _ in ok([:]) }
        var inp = AnalysisInput(lines: [], imageWidth: 50, imageHeight: 1500)
        inp.imageProvider = { _ in nil }
        let r = try await RedactionEngine(settings: s, client: makeClient(t)).analyze(inp)
        XCTAssertTrue(t.requests.isEmpty)
        XCTAssertTrue(r.warnings.contains { $0.contains("Skipped visual check") })
    }

    func testPaddingAndMerge() async throws {
        var s = AppSettings()
        s.aiEnabled = false
        s.paddingPixels = 10
        let inp = AnalysisInput(
            lines: [], localRegions: [Finding(rect: NormRect(left: 0.1, top: 0.1, right: 0.2, bottom: 0.2), category: "x", source: .local),
                                       Finding(rect: NormRect(left: 0.2, top: 0.1, right: 0.3, bottom: 0.2), category: "y", source: .local)],
            imageWidth: 1000, imageHeight: 1000)
        let r = try await RedactionEngine(settings: s, client: nil).analyze(inp)
        XCTAssertEqual(r.rects.count, 1)
        XCTAssertEqual(r.rects[0].left, 0.09, accuracy: 1e-9)
        XCTAssertEqual(r.rects[0].right, 0.31, accuracy: 1e-9)
    }

    func testMaskReplacesRanges() {
        let (m, cov) = RedactionEngine.mask("a bob@x.io b", matches: [LocalMatch(category: "e", range: NSRange(location: 2, length: 8))])
        XCTAssertEqual(m, "a [HIDDEN] b")
        XCTAssertEqual(cov, 8.0 / 12.0, accuracy: 1e-9)
    }

    func testReadingOrderSortsByRow() {
        let a = line("second", row: 5), b = line("first", row: 1)
        XCTAssertEqual(RedactionEngine.readingOrder([a, b]).map { $0.text }, ["first", "second"])
    }

    func testSafeFallbackRangeRect() {
        let l = OCRLine(text: "0123456789", rect: NormRect(left: 0, top: 0, right: 1, bottom: 0.1))
        let r = l.rect(for: NSRange(location: 2, length: 3))
        XCTAssertEqual(r, l.rect)
    }
    func testOnlyAndyIsHiddenInInvoiceSentence() async throws {
        let text = "Send custom invoice to Andy"
        let source = line(text, row: 0)
        let transport = MockTransport { request, _ in
            let body = requestJSON(request)
            let words = body["state"]?["words"]?.objectValue
            var answers: [String: JSONValue] = [:]
            for id in (body["questions"]?.objectValue ?? [:]).keys {
                let probability = words.map { $0[id]?["text"]?.stringValue == "Andy" ? 0.99 : 0.01 } ?? 0.99
                answers[id] = ["type": "noul", "noul": .number(probability)]
            }
            return ok(answers)
        }
        let result = try await RedactionEngine(settings: AppSettings(), client: makeClient(transport)).analyze(
            AnalysisInput(lines: [source], imageWidth: 2000, imageHeight: 1000))
        let ai = result.findings.filter { $0.source == .ai }
        XCTAssertEqual(ai.count, 1)
        XCTAssertEqual(ai.first?.rect, source.rect(for: (text as NSString).range(of: "Andy")))
        XCTAssertEqual(transport.requests.count, 2)
    }

}
