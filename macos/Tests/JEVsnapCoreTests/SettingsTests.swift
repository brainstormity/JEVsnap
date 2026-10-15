import XCTest
@testable import JEVsnapCore

final class SettingsTests: XCTestCase {
    func testRoundTrip() throws {
        var s = AppSettings()
        s.saveFolderPath = "/tmp/shots"
        s.aiThreshold = 0.3
        s.enabledDetectors = [.email, .jwt]
        let data = try JSONEncoder().encode(s)
        XCTAssertEqual(try JSONDecoder().decode(AppSettings.self, from: data), s)
    }

    func testOlderSettingsFileFallsBackToDefaults() throws {
        let old = #"{"saveFolderPath":"/x","aiThreshold":0.7,"someFutureKey":1}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(AppSettings.self, from: old)
        XCTAssertEqual(s.saveFolderPath, "/x")
        XCTAssertEqual(s.aiThreshold, 0.7)
        XCTAssertEqual(s.hotKey, .default)
        XCTAssertTrue(s.copyToClipboard)
    }

    func testWrongTypeFallsBackToDefault() throws {
        let bad = #"{"aiThreshold":"high","saveOriginals":false}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(AppSettings.self, from: bad)
        XCTAssertEqual(s.aiThreshold, 0.5)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as! [String: Any]
        XCTAssertNil(encoded["saveOriginals"])
    }

    func testLineLists() {
        var s = AppSettings()
        s.customPhrasesText = "  one \n\n two\r\n"
        XCTAssertEqual(s.customPhrases, ["one", "two"])
    }

    func testHotKeyDisplay() {
        XCTAssertEqual(HotKeySetting.default.displayString, "⇧⌘6")
        XCTAssertEqual(HotKeySetting(keyCode: 1, modifiers: 4096 | 2048 | 256, label: "s").displayString, "⌃⌥⌘S")
    }
}
