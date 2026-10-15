import Foundation

/// A rectangle in normalized image coordinates: (0,0) is the TOP-left corner and
/// (1,1) the bottom-right. This is the same convention the Jev Box type uses.
/// (Apple Vision uses a bottom-left origin; the macOS layer converts.)
public struct NormRect: Codable, Equatable, Hashable, Sendable {
    public var left: Double
    public var top: Double
    public var right: Double
    public var bottom: Double

    public init(left: Double, top: Double, right: Double, bottom: Double) {
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom
    }

    public var width: Double { right - left }
    public var height: Double { bottom - top }
    public var isValid: Bool {
        [left, top, right, bottom].allSatisfy { $0.isFinite } && right > left && bottom > top
    }

    /// Clamps every edge into 0...1.
    public func clamped() -> NormRect {
        func c(_ v: Double) -> Double { min(1, max(0, v)) }
        return NormRect(left: c(left), top: c(top), right: c(right), bottom: c(bottom))
    }

    public func union(_ o: NormRect) -> NormRect {
        NormRect(left: min(left, o.left), top: min(top, o.top),
                 right: max(right, o.right), bottom: max(bottom, o.bottom))
    }

    /// True when the two rectangles overlap, or come within `tolerance` of touching.
    public func intersects(_ o: NormRect, tolerance: Double = 0) -> Bool {
        left <= o.right + tolerance && o.left <= right + tolerance &&
            top <= o.bottom + tolerance && o.top <= bottom + tolerance
    }

    public func padded(dx: Double, dy: Double) -> NormRect {
        NormRect(left: left - dx, top: top - dy, right: right + dx, bottom: bottom + dy).clamped()
    }
}

public enum Geometry {
    /// Repeatedly unions rectangles that overlap (or nearly touch) until none do.
    public static func mergeOverlapping(_ rects: [NormRect], tolerance: Double = 0) -> [NormRect] {
        var result = rects.filter { $0.isValid }
        var changed = true
        while changed {
            changed = false
            outer: for i in 0..<result.count {
                for j in (i + 1)..<max(i + 1, result.count) where result[i].intersects(result[j], tolerance: tolerance) {
                    result[i] = result[i].union(result[j])
                    result.remove(at: j)
                    changed = true
                    break outer
                }
            }
        }
        return result
    }
}

/// Size limits of the Jev image API (docs.typesafe.ai/images#limits).
public enum ImageLimits {
    public static let minSide = 256
    public static let maxSide = 1568
    public static let minPixels = 78_400
    public static let maxPixels = 2_458_624

    /// The size to resize an image to before sending it to Jev, preserving aspect
    /// ratio (so Box fractions still map onto the original). Returns nil when no size
    /// can satisfy the API limits (e.g. an extremely thin strip).
    public static func targetSize(width: Int, height: Int) -> (width: Int, height: Int)? {
        guard width > 0, height > 0 else { return nil }
        let w = Double(width), h = Double(height)
        var scale = 1.0
        if max(w, h) > Double(maxSide) { scale = Double(maxSide) / max(w, h) }
        let px = w * h * scale * scale
        if px > Double(maxPixels) { scale *= (Double(maxPixels) / px).squareRoot() * 0.995 }
        let minScale = max(Double(minSide) / min(w, h), (Double(minPixels) / (w * h)).squareRoot())
        scale = max(scale, minScale)
        let nw = Int((w * scale).rounded()), nh = Int((h * scale).rounded())
        guard (minSide...maxSide).contains(nw), (minSide...maxSide).contains(nh),
              (minPixels...maxPixels).contains(nw * nh) else { return nil }
        return (nw, nh)
    }
}
