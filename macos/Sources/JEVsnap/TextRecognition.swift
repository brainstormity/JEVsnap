import CoreGraphics
import Foundation
import JEVsnapCore
import Vision

/// Everything Apple's Vision framework finds on-device. Nothing here touches the network.
struct VisionResults {
    var lines: [OCRLine] = []
    var regions: [Finding] = []
    var warnings: [String] = []
}

enum TextRecognition {
    /// Vision uses a bottom-left origin; JEVsnapCore uses top-left.
    static func normRect(fromVision box: CGRect) -> NormRect {
        NormRect(left: Double(box.minX), top: 1 - Double(box.maxY),
                 right: Double(box.maxX), bottom: 1 - Double(box.minY)).clamped()
    }

    static func analyze(_ image: CGImage, faces: Bool, barcodes: Bool) throws -> VisionResults {
        var out = VisionResults()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])

        // Text (required: if OCR fails we cannot redact reliably, so this error propagates).
        let textRequest = VNRecognizeTextRequest()
        textRequest.recognitionLevel = .accurate
        textRequest.usesLanguageCorrection = false    // keys, tokens and hostnames must not be "corrected"
        try handler.perform([textRequest])
        for observation in textRequest.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string
            let rect = normRect(fromVision: observation.boundingBox)
            let rangeRect: (NSRange) -> NormRect? = { nsRange in
                guard let range = Range(nsRange, in: text),
                      let sub = try? candidate.boundingBox(for: range) else { return nil }
                return normRect(fromVision: sub.boundingBox)
            }
            out.lines.append(OCRLine(text: text, rect: rect, rangeRect: rangeRect))
        }

        if faces {
            let request = VNDetectFaceRectanglesRequest()
            do {
                try handler.perform([request])
                for f in request.results ?? [] {
                    // Tight face boxes miss hair and chin; grow them a little.
                    let r = normRect(fromVision: f.boundingBox)
                    out.regions.append(Finding(rect: r.padded(dx: r.width * 0.12, dy: r.height * 0.15),
                                               category: "Face", source: .local))
                }
            } catch {
                out.warnings.append("Face detection failed: \(error.localizedDescription)")
            }
        }

        if barcodes {
            let request = VNDetectBarcodesRequest()
            do {
                try handler.perform([request])
                for b in request.results ?? [] {
                    out.regions.append(Finding(rect: normRect(fromVision: b.boundingBox),
                                               category: "QR code / barcode", source: .local))
                }
            } catch {
                out.warnings.append("Barcode detection failed: \(error.localizedDescription)")
            }
        }
        return out
    }
}
