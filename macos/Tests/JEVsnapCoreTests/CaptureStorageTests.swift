import XCTest
@testable import JEVsnapCore

final class CaptureStorageTests: XCTestCase {
    func testCompletedImagesRouteByRedactionAndNeverOverwrite() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let png = Data("processed".utf8)
        let date = Date(timeIntervalSince1970: 0)
        let redacted = try CaptureStorage.save(png, in: folder, hasRedactions: true, now: date)
        let clean = try CaptureStorage.save(png, in: folder, hasRedactions: false, now: date)
        let second = try CaptureStorage.save(png, in: folder, hasRedactions: false, now: date)
        XCTAssertEqual(redacted.deletingLastPathComponent().lastPathComponent, "Redacted")
        XCTAssertEqual(clean.deletingLastPathComponent().lastPathComponent, "Not Redacted")
        XCTAssertNotEqual(clean, second)
        XCTAssertEqual(try Data(contentsOf: clean), png)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("Originals").path))
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: folder.path)), ["Redacted", "Not Redacted"])
    }

    func testTemporaryCaptureCleanupOnSuccessAndScopeExit() throws {
        var path: URL!
        do {
            let capture = try TemporaryCapture()
            path = capture.directoryURL
            try Data("raw".utf8).write(to: capture.imageURL)
            let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
            try capture.cleanup()
            try capture.cleanup() // safe when already removed
            XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
        }
        do {
            let capture = try TemporaryCapture()
            path = capture.directoryURL
            try Data("raw".utf8).write(to: capture.imageURL)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
    }
}
