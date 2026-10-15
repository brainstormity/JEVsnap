import Foundation

public enum FindingSource: String, Codable, Sendable {
    case rule      // local regex / validator
    case local     // local Vision detectors (faces, barcodes)
    case ai        // Jev text classification of OCR lines
    case visual    // Jev Box on the (already partly redacted) image
}

/// One region that will be blacked out. Never stores the sensitive text itself.
public struct Finding: Equatable, Sendable {
    public var rect: NormRect
    public var category: String
    public var source: FindingSource
    public var confidence: Double?

    public init(rect: NormRect, category: String, source: FindingSource, confidence: Double? = nil) {
        self.rect = rect
        self.category = category
        self.source = source
        self.confidence = confidence
    }
}

/// A line of text recognized in the screenshot.
public struct OCRLine {
    public var text: String
    /// Whole-line rectangle (top-left origin, normalized).
    public var rect: NormRect
    /// Optional precise rectangle for a sub-range of `text` (UTF-16 NSRange).
    /// The macOS layer backs this with Vision's per-range boxes.
    public var rangeRect: ((NSRange) -> NormRect?)?

    public init(text: String, rect: NormRect, rangeRect: ((NSRange) -> NormRect?)? = nil) {
        self.text = text
        self.rect = rect
        self.rangeRect = rangeRect
    }

    /// Rectangle for a sub-range; covers the whole line when precise glyph geometry is unavailable.
    public func rect(for range: NSRange) -> NormRect {
        if let precise = rangeRect?(range), precise.isValid { return precise }
        // Without glyph geometry, proportional widths can expose variable-width characters.
        return rect
    }
}

/// An image prepared for the Jev API (PNG or JPEG within the API limits).
public struct ImagePayload: Sendable {
    public var data: Data
    public var format: String   // "png" or "jpg"
    public init(data: Data, format: String) {
        self.data = data
        self.format = format
    }
}
