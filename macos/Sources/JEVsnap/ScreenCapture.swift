import AppKit
import CoreGraphics
import ScreenCaptureKit
import JEVsnapCore

/// Captures with the system `screencapture` tool: it provides the native crosshair/window
/// picker, handles multi-display and Retina correctly, and writes a full-resolution PNG.
enum ScreenCapture {
    enum Mode { case region, window, fullScreen }

    enum CaptureError: LocalizedError {
        case launchFailed(String)
        case failed(Int32)
        case permissionDenied
        var errorDescription: String? {
            switch self {
            case .launchFailed(let m): return "Could not start screencapture: \(m)"
            case .failed(let c): return "screencapture failed (exit code \(c))."
            case .permissionDenied: return "macOS denied Screen Recording access for this installation of JEVsnap."
            }
        }
    }

    @MainActor private static let permissionGate = ScreenRecordingPermissionGate()

    @MainActor
    static func ensurePermission() async throws -> Bool {
        try await permissionGate.authorize(preflight: { CGPreflightScreenCaptureAccess() }, verifyAccess: {
            do {
                _ = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                return true
            } catch {
                let nsError = error as NSError
                if nsError.domain == SCStreamErrorDomain && nsError.code == SCStreamError.userDeclined.rawValue {
                    return false
                }
                throw error
            }
        }, requestAccess: { CGRequestScreenCaptureAccess() })
    }

    /// Returns false when the user cancelled (Esc) and no file was produced.
    static func capture(_ mode: Mode, to url: URL) async throws -> Bool {
        var args = ["-x", "-t", "png"]          // -x: no shutter sound
        switch mode {
        case .region: args += ["-i", "-s"]      // interactive, mouse selection only
        case .window: args += ["-i", "-w", "-o"] // window picker, no drop shadow
        case .fullScreen: args += ["-m"]        // main display
        }
        args.append(url.path)

        return try await withCheckedThrowingContinuation { cont in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = args
            let errors = Pipe()
            process.standardError = errors
            process.terminationHandler = { p in
                let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
                let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
                let diagnostic = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).lowercased()
                if size > 0 {
                    cont.resume(returning: true)
                } else if diagnostic.contains("could not create image from display") || diagnostic.contains("not permitted") || diagnostic.contains("not authorized") {
                    cont.resume(throwing: CaptureError.permissionDenied)
                } else if p.terminationStatus == 0 || (p.terminationStatus == 1 && diagnostic.isEmpty) {
                    cont.resume(returning: false)   // cancelled
                } else {
                    cont.resume(throwing: CaptureError.failed(p.terminationStatus))
                }
            }
            do {
                try process.run()
            } catch {
                cont.resume(throwing: CaptureError.launchFailed(error.localizedDescription))
            }
        }
    }
}
