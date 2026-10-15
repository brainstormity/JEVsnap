import Foundation

/// A stale CoreGraphics preflight result must not override a successful access check.
/// Explicit permission requests happen at most once per app session.
@MainActor
public final class ScreenRecordingPermissionGate {
    private var didRequest = false

    public init() {}

    public func authorize(preflight: () -> Bool, verifyAccess: () async throws -> Bool,
                          requestAccess: () -> Bool) async throws -> Bool {
        if preflight() { return true }
        if try await verifyAccess() { return true }
        guard !didRequest else { return false }
        didRequest = true
        if requestAccess() || preflight() { return true }
        return try await verifyAccess()
    }
}
