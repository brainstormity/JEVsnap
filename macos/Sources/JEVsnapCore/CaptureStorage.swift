import Foundation

/// A raw capture exists only in a private temporary directory while it is being processed.
public final class TemporaryCapture {
    public let directoryURL: URL
    public let imageURL: URL

    public init(temporaryDirectory: URL = FileManager.default.temporaryDirectory) throws {
        directoryURL = temporaryDirectory.appendingPathComponent("jevsnap-" + UUID().uuidString, isDirectory: true)
        imageURL = directoryURL.appendingPathComponent("capture.png")
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
    }

    public func cleanup() throws {
        if FileManager.default.fileExists(atPath: directoryURL.path) {
            try FileManager.default.removeItem(at: directoryURL)
        }
    }

    deinit { try? cleanup() }
}

public enum CaptureStorage {
    /// Save only the completed PNG, routing by whether pixels were actually redacted.
    @discardableResult
    public static func save(_ png: Data, in folder: URL, hasRedactions: Bool, now: Date = Date()) throws -> URL {
        let fm = FileManager.default
        let output = folder.appendingPathComponent(hasRedactions ? "Redacted" : "Not Redacted", isDirectory: true)
        try fm.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: output.path)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let base = "Screenshot \(formatter.string(from: now))"
        var name = base
        var n = 2
        while fm.fileExists(atPath: output.appendingPathComponent(name + ".png").path) {
            name = "\(base) (\(n))"
            n += 1
        }
        let destination = output.appendingPathComponent(name + ".png")
        try png.write(to: destination, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        return destination
    }
}
