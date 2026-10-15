import XCTest
@testable import JEVsnapCore

final class GeometryTests: XCTestCase {
    func testMergeOverlapping() {
        let a = NormRect(left: 0.1, top: 0.1, right: 0.3, bottom: 0.2)
        let b = NormRect(left: 0.25, top: 0.15, right: 0.5, bottom: 0.3)
        let c = NormRect(left: 0.8, top: 0.8, right: 0.9, bottom: 0.9)
        let merged = Geometry.mergeOverlapping([a, b, c])
        XCTAssertEqual(merged.count, 2)
        XCTAssertTrue(merged.contains(NormRect(left: 0.1, top: 0.1, right: 0.5, bottom: 0.3)))
        XCTAssertTrue(merged.contains(c))
    }

    func testMergeChain() {
        let r = (0..<5).map { NormRect(left: Double($0) * 0.1, top: 0, right: Double($0) * 0.1 + 0.12, bottom: 0.1) }
        XCTAssertEqual(Geometry.mergeOverlapping(r).count, 1)
    }

    func testMergeDropsInvalid() {
        XCTAssertTrue(Geometry.mergeOverlapping([NormRect(left: 0.5, top: 0.5, right: 0.4, bottom: 0.6)]).isEmpty)
    }

    func testPaddingClamps() {
        let r = NormRect(left: 0.01, top: 0.01, right: 0.5, bottom: 0.99).padded(dx: 0.05, dy: 0.05)
        XCTAssertEqual(r.left, 0); XCTAssertEqual(r.top, 0); XCTAssertEqual(r.bottom, 1)
        XCTAssertEqual(r.right, 0.55, accuracy: 1e-9)
    }

    func testImageLimitsDownscaleRetina() throws {
        let s = try XCTUnwrap(ImageLimits.targetSize(width: 2880, height: 1800))
        XCTAssertEqual(s.width, 1568)
        XCTAssertLessThanOrEqual(s.width * s.height, ImageLimits.maxPixels)
        XCTAssertEqual(Double(s.width) / Double(s.height), 2880.0 / 1800.0, accuracy: 0.01)
    }

    func testImageLimitsSquareLargeStaysUnderPixelCap() throws {
        let s = try XCTUnwrap(ImageLimits.targetSize(width: 4000, height: 4000))
        XCTAssertLessThanOrEqual(s.width * s.height, ImageLimits.maxPixels)
        XCTAssertLessThanOrEqual(max(s.width, s.height), ImageLimits.maxSide)
    }

    func testImageLimitsUpscalesSmall() throws {
        let s = try XCTUnwrap(ImageLimits.targetSize(width: 200, height: 120))
        XCTAssertGreaterThanOrEqual(min(s.width, s.height), 256)
        XCTAssertGreaterThanOrEqual(s.width * s.height, ImageLimits.minPixels)
    }

    func testImageLimitsRejectsImpossibleStrip() {
        XCTAssertNil(ImageLimits.targetSize(width: 50, height: 1500))
        XCTAssertNil(ImageLimits.targetSize(width: 0, height: 10))
    }
}
