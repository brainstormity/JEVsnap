import AppKit
import CoreGraphics
import ImageIO
import JEVsnapCore
import UniformTypeIdentifiers

enum ImageTools {
    enum ImageError: LocalizedError {
        case cannotRead(String)
        case cannotRender
        case cannotEncode
        var errorDescription: String? {
            switch self {
            case .cannotRead(let p): return "Could not read the captured image at \(p)."
            case .cannotRender: return "Could not render the redacted image."
            case .cannotEncode: return "Could not encode the redacted image as PNG."
            }
        }
    }

    static func load(_ url: URL) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw ImageError.cannotRead(url.path)
        }
        return image
    }

    /// Pixel rectangle (CoreGraphics origin = bottom-left) for a top-left normalized rect,
    /// rounded outward so edges are always fully covered.
    static func pixelRect(_ r: NormRect, width: Int, height: Int) -> CGRect {
        let w = Double(width), h = Double(height)
        let x0 = (r.left * w).rounded(.down), x1 = (r.right * w).rounded(.up)
        let y0 = (r.top * h).rounded(.down), y1 = (r.bottom * h).rounded(.up)
        return CGRect(x: x0, y: h - y1, width: x1 - x0, height: y1 - y0)
    }

    private static func makeContext(width: Int, height: Int, preferring space: CGColorSpace?,
                                    alpha: CGImageAlphaInfo) -> CGContext? {
        let fallback = CGColorSpace(name: CGColorSpace.sRGB)
        for cs in [space, fallback] {
            guard let cs = cs else { continue }
            if let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: cs, bitmapInfo: alpha.rawValue) {
                return ctx
            }
        }
        return nil
    }

    /// Returns a copy of `image` with solid black boxes over `rects`. The output is
    /// re-rendered from pixels, so no metadata from the source file is carried over.
    static func redact(_ image: CGImage, rects: [NormRect]) throws -> CGImage {
        let w = image.width, h = image.height
        guard let ctx = makeContext(width: w, height: h, preferring: image.colorSpace, alpha: .premultipliedLast) else {
            throw ImageError.cannotRender
        }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        for r in rects { ctx.fill(pixelRect(r, width: w, height: h)) }
        guard let out = ctx.makeImage() else { throw ImageError.cannotRender }
        return out
    }

    static func pngData(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw ImageError.cannotEncode
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw ImageError.cannotEncode }
        return data as Data
    }

    /// Resized JPEG for the Jev Box pass, with everything found so far already blacked out.
    /// Returns nil when the image cannot satisfy the API's size limits.
    static func jevPayload(from image: CGImage, blackout rects: [NormRect]) -> ImagePayload? {
        guard let size = ImageLimits.targetSize(width: image.width, height: image.height),
              let redacted = try? redact(image, rects: rects),
              let ctx = makeContext(width: size.width, height: size.height, preferring: nil, alpha: .noneSkipLast)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(redacted, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        guard let small = ctx.makeImage() else { return nil }

        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary
        CGImageDestinationAddImage(dest, small, options)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return ImagePayload(data: data as Data, format: "jpg")
    }

    static func copyToClipboard(pngData: Data) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.declareTypes([.png, .tiff], owner: nil)
        pb.setData(pngData, forType: .png)
        if let tiff = NSImage(data: pngData)?.tiffRepresentation { pb.setData(tiff, forType: .tiff) }
    }
}
