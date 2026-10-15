import XCTest
@testable import JEVsnapCore

@MainActor
final class ScreenRecordingPermissionGateTests: XCTestCase {
    func testExistingPermissionDoesNotRequestAgain() async throws {
        let gate = ScreenRecordingPermissionGate()
        let allowed = try await gate.authorize(preflight: { true }, verifyAccess: { XCTFail("unnecessary probe"); return false },
                                               requestAccess: { XCTFail("unnecessary request"); return false })
        XCTAssertTrue(allowed)
    }

    func testSuccessfulModernCheckOverridesStalePreflight() async throws {
        let gate = ScreenRecordingPermissionGate()
        let allowed = try await gate.authorize(preflight: { false }, verifyAccess: { true },
                                               requestAccess: { XCTFail("already authorized"); return false })
        XCTAssertTrue(allowed)
    }

    func testPermissionRequestResultIsHonored() async throws {
        let gate = ScreenRecordingPermissionGate()
        var requests = 0
        let allowed = try await gate.authorize(preflight: { false }, verifyAccess: { false },
                                               requestAccess: { requests += 1; return true })
        XCTAssertTrue(allowed)
        XCTAssertEqual(requests, 1)
    }

    func testDenialDoesNotLoopAndLaterApprovalIsRechecked() async throws {
        let gate = ScreenRecordingPermissionGate()
        var requests = 0
        for _ in 0..<3 {
            let allowed = try await gate.authorize(preflight: { false }, verifyAccess: { false },
                                                   requestAccess: { requests += 1; return false })
            XCTAssertFalse(allowed)
        }
        XCTAssertEqual(requests, 1)
        let allowed = try await gate.authorize(preflight: { false }, verifyAccess: { true },
                                               requestAccess: { XCTFail("must reuse access"); return false })
        XCTAssertTrue(allowed)
    }

    func testUnrelatedProbeFailureDoesNotRequestPermission() async {
        struct ProbeFailure: Error {}
        do {
            _ = try await ScreenRecordingPermissionGate().authorize(preflight: { false }, verifyAccess: { throw ProbeFailure() },
                requestAccess: { XCTFail("must not confuse capture errors with permission denial"); return false })
            XCTFail("expected error")
        } catch { XCTAssertTrue(error is ProbeFailure) }
    }

}
