import CoreGraphics
import Foundation
import JEVsnapCore

struct ProcessedCapture {
    var redactedPNG: Data
    var result: AnalysisResult
    var ocrLineCount: Int
}

enum CaptureProcessor {
    /// OCR + detection + rendering. Runs off the main thread. Throws on anything that would
    /// make the output unsafe to share (e.g. OCR failure), so the caller never copies a
    /// half-processed image.
    static func process(imageURL: URL, settings: AppSettings, apiKey: String) async throws -> ProcessedCapture {
        let image = try ImageTools.load(imageURL)
        let vision = try TextRecognition.analyze(image, faces: settings.detectFaces, barcodes: settings.detectBarcodes)

        var clientWarning: String?
        var client: JevClient?
        if !apiKey.isEmpty && (settings.aiEnabled || settings.visualEnabled) {
            do {
                client = try JevClient(apiKey: apiKey, baseURL: settings.apiBaseURL, timeout: settings.requestTimeoutSeconds)
            } catch {
                clientWarning = error.localizedDescription
                if settings.abortIfAIUnavailable { throw error }
            }
        }

        let engine = RedactionEngine(settings: settings, client: client)
        let input = AnalysisInput(
            lines: vision.lines,
            localRegions: vision.regions,
            imageWidth: image.width,
            imageHeight: image.height,
            imageProvider: { rects in ImageTools.jevPayload(from: image, blackout: rects) })
        var result = try await engine.analyze(input)
        result.warnings.append(contentsOf: vision.warnings)
        if let w = clientWarning { result.warnings.append(w) }

        let redacted = try ImageTools.redact(image, rects: result.rects)
        return ProcessedCapture(redactedPNG: try ImageTools.pngData(redacted), result: result, ocrLineCount: vision.lines.count)
    }
}
