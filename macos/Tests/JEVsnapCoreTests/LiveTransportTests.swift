import XCTest
@testable import JEVsnapCore

/// Exercises the real URLSession transport against a local mock server.
/// Skipped unless JEVSNAP_TEST_SERVER is set, e.g. via `tools/mock_jev_server.py`.
final class LiveTransportTests: XCTestCase {
    func testEngineOverRealHTTP() async throws {
        guard let base = ProcessInfo.processInfo.environment["JEVSNAP_TEST_SERVER"] else {
            throw XCTSkip("Set JEVSNAP_TEST_SERVER (see tools/mock_jev_server.py) to run this test.")
        }
        let client = try JevClient(apiKey: "testkey", baseURL: base, timeout: 5, maxRetries: 2)
        let models = try await client.listModels()
        XCTAssertTrue(models.contains("jev-preview"))

        let input = AnalysisInput(
            lines: [line("Dashboard", row: 0), line("Owner: Jane Doe", row: 1), line("DB_PASSWORD=hunter2hunter2", row: 2)],
            imageWidth: 1000, imageHeight: 1000)
        let result = try await RedactionEngine(settings: AppSettings(), client: client).analyze(input)
        XCTAssertTrue(result.aiRan, "warnings: \(result.warnings)")
        XCTAssertEqual(result.findings.filter { $0.source == .ai }.count, 1)
        XCTAssertEqual(result.findings.filter { $0.source == .rule }.count, 1)
    }

    func testBadKeyAgainstRealHTTP() async throws {
        guard let base = ProcessInfo.processInfo.environment["JEVSNAP_TEST_SERVER"] else { throw XCTSkip("no server") }
        let client = try JevClient(apiKey: "wrong", baseURL: base, timeout: 5, maxRetries: 0)
        do {
            _ = try await client.listModels()
            XCTFail("expected 401")
        } catch {
            XCTAssertEqual(error as? JevError, .unauthorized)
        }
    }
}
