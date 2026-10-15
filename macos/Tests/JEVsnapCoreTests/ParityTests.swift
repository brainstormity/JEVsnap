import XCTest
@testable import JEVsnapCore

/// Runs the detector vectors shared with the TypeScript desktop app (shared/detector-cases.json)
/// so both implementations stay behaviorally identical.
final class ParityTests: XCTestCase {
    private struct Doc: Decodable { let cases: [Case] }
    private struct Case: Decodable {
        let name: String
        let text: String
        let expect: [String]
        let mode: String?
        let detectors: [String]?
        let settings: [String: String]?

        private enum Keys: String, CodingKey { case name, text, expect, mode, detectors, settings }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            name = try c.decode(String.self, forKey: .name)
            // "text" is a string, or an array of strings to concatenate.
            if let s = try? c.decode(String.self, forKey: .text) { text = s } else { text = try c.decode([String].self, forKey: .text).joined() }
            // Each expectation is a string, or an array of strings to concatenate.
            var items = try c.nestedUnkeyedContainer(forKey: .expect)
            var parsed: [String] = []
            while !items.isAtEnd {
                if let s = try? items.decode(String.self) { parsed.append(s) } else { parsed.append(try items.decode([String].self).joined()) }
            }
            expect = parsed
            mode = try c.decodeIfPresent(String.self, forKey: .mode)
            detectors = try c.decodeIfPresent([String].self, forKey: .detectors)
            settings = try c.decodeIfPresent([String: String].self, forKey: .settings)
        }
    }

    func testSharedDetectorVectors() throws {
        // macos/Tests/JEVsnapCoreTests/ParityTests.swift -> repo root is four levels up.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("shared/detector-cases.json"))
        let doc = try JSONDecoder().decode(Doc.self, from: data)
        XCTAssertGreaterThan(doc.cases.count, 30)

        for c in doc.cases {
            var s = AppSettings()
            if let d = c.detectors { s.enabledDetectors = Set(d.compactMap { DetectorKind(rawValue: $0) }) }
            if let o = c.settings {
                s.customPhrasesText = o["customPhrasesText"] ?? s.customPhrasesText
                s.customRegexesText = o["customRegexesText"] ?? s.customRegexesText
                s.allowlistText = o["allowlistText"] ?? s.allowlistText
            }
            let ns = c.text as NSString
            let found = LocalDetector(settings: s).matches(in: c.text).map { ns.substring(with: $0.range) }
            if c.mode == "contains" {
                for e in c.expect { XCTAssertTrue(found.contains(e), "[\(c.name)] expected match \(e), got \(found)") }
            } else {
                XCTAssertEqual(found.sorted(), c.expect.sorted(), "[\(c.name)]")
            }
        }
    }
}
