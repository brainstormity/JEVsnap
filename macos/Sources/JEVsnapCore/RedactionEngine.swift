import Foundation

public struct AnalysisInput {
    /// OCR output (any order; the engine sorts into reading order).
    public var lines: [OCRLine]
    /// Regions found by local Vision detectors (faces, barcodes), already in top-left normalized coordinates.
    public var localRegions: [Finding]
    public var imageWidth: Int
    public var imageHeight: Int
    /// Produces the image to send to Jev Box, with the given rectangles already blacked out,
    /// so nothing the earlier stages found ever leaves the machine. Nil disables the visual pass.
    public var imageProvider: (([NormRect]) -> ImagePayload?)?

    public init(lines: [OCRLine], localRegions: [Finding] = [], imageWidth: Int, imageHeight: Int,
                imageProvider: (([NormRect]) -> ImagePayload?)? = nil) {
        self.lines = lines
        self.localRegions = localRegions
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.imageProvider = imageProvider
    }
}

public struct AnalysisResult {
    public var findings: [Finding]
    /// Final merged + padded rectangles to black out.
    public var rects: [NormRect]
    public var warnings: [String]
    public var aiRan: Bool
    public var visualRan: Bool

    /// e.g. ["Email addresses": 2, "AI: sensitive text": 3]
    public var summary: [String: Int] {
        var s: [String: Int] = [:]
        for f in findings { s[f.category, default: 0] += 1 }
        return s
    }
}

/// Orchestrates the three detection stages:
///   1. local rules on OCR text (offline),
///   2. Jev text questions about each OCR line (only text leaves the machine, secrets masked),
///   3. optional Jev Box questions on the image for user-defined visual targets.
public final class RedactionEngine {
    public static let aiCategory = "AI: sensitive text"

    private let settings: AppSettings
    private let client: JevClient?

    static let linesPerRequest = 40
    static let contextLines = 4
    static let maxQuestionLines = 600
    static let maxConcurrentRequests = 4
    static let maxVisualTargets = 8

    public init(settings: AppSettings, client: JevClient?) {
        self.settings = settings.normalized()
        self.client = client
    }

    public func analyze(_ input: AnalysisInput) async throws -> AnalysisResult {
        var findings = input.localRegions
        var warnings: [String] = []
        var aiRan = false
        var visualRan = false

        let lines = RedactionEngine.readingOrder(input.lines)
        let detector = LocalDetector(settings: settings)
        for bad in detector.invalidCustomRegexes { warnings.append("Ignored invalid custom pattern: \(bad)") }

        // Stage 1: local rules.
        var maskedText: [String] = []
        var inPrivateKey = false
        for line in lines {
            var ms = detector.matches(in: line.text)
            if settings.enabledDetectors.contains(.privateKey) {
                if line.text.range(of: #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#, options: .regularExpression) != nil {
                    inPrivateKey = true
                }
                if inPrivateKey {
                    ms.append(LocalMatch(category: "Private key material", range: NSRange(location: 0, length: (line.text as NSString).length)))
                }
                if line.text.range(of: #"-----END [A-Z ]*PRIVATE KEY-----"#, options: .regularExpression) != nil {
                    inPrivateKey = false
                }
            }
            for m in ms {
                findings.append(Finding(rect: line.rect(for: m.range), category: m.category, source: .rule))
            }
            let (masked, _) = RedactionEngine.mask(line.text, matches: ms)
            maskedText.append(masked)
        }

        // Stage 2: Jev text check.
        if settings.aiEnabled {
            if let client = client {
                do {
                    let flagged = try await classifyLines(lines: lines, maskedText: maskedText,
                                                          client: client, warnings: &warnings)
                    aiRan = true
                    findings.append(contentsOf: try await refineSensitiveWords(lines: lines, maskedText: maskedText,
                                                                               flagged: flagged, detector: detector,
                                                                               client: client, warnings: &warnings))
                } catch {
                    if settings.abortIfAIUnavailable { throw error }
                    warnings.append("AI check unavailable (\(error.localizedDescription)); used local rules only.")
                }
            } else {
                if settings.abortIfAIUnavailable { throw JevError.missingAPIKey }
                warnings.append("No API key set; used local rules only.")
            }
        }

        // Stage 3: optional visual targets via Box.
        if settings.visualEnabled, !settings.visualTargets.isEmpty {
            if let client = client {
                let soFar = RedactionEngine.finalRects(findings, input: input, settings: settings)
                if let payload = input.imageProvider?(soFar) {
                    do {
                        let (visual, w) = try await visualFindings(payload: payload, client: client)
                        findings.append(contentsOf: visual)
                        warnings.append(contentsOf: w)
                        visualRan = true
                    } catch {
                        if settings.abortIfAIUnavailable { throw error }
                        warnings.append("Visual check unavailable (\(error.localizedDescription)).")
                    }
                } else {
                    if settings.abortIfAIUnavailable { throw JevError.badRequest("The required visual check has no image within API limits.") }
                    warnings.append("Skipped visual check: image is unavailable or outside the API limits.")
                }
            } else {
                if settings.abortIfAIUnavailable { throw JevError.missingAPIKey }
                warnings.append("Visual check skipped: no API key set.")
            }
        }

        let rects = RedactionEngine.finalRects(findings, input: input, settings: settings)
        return AnalysisResult(findings: findings, rects: rects, warnings: warnings, aiRan: aiRan, visualRan: visualRan)
    }

    // MARK: - Helpers

    static func finalRects(_ findings: [Finding], input: AnalysisInput, settings: AppSettings) -> [NormRect] {
        let dx = settings.paddingPixels / Double(max(1, input.imageWidth))
        let dy = settings.paddingPixels / Double(max(1, input.imageHeight))
        let padded = findings.map { $0.rect.clamped().padded(dx: dx, dy: dy) }
        return Geometry.mergeOverlapping(padded)
    }

    static func readingOrder(_ lines: [OCRLine]) -> [OCRLine] {
        lines.filter { $0.rect.isValid && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
            .sorted { a, b in
                if abs(a.rect.top - b.rect.top) > 0.004 { return a.rect.top < b.rect.top }
                return a.rect.left < b.rect.left
            }
    }

    /// Replaces matched ranges with [HIDDEN]; returns the masked text and the fraction of the line covered.
    static func mask(_ text: String, matches: [LocalMatch]) -> (String, Double) {
        guard !matches.isEmpty else { return (text, 0) }
        let ns = text as NSString
        let sorted = matches.sorted { $0.range.location < $1.range.location }
        var out = ""
        var cursor = 0
        var covered = 0
        for m in sorted {
            let start = max(m.range.location, cursor)
            let end = m.range.location + m.range.length
            guard end > start else { continue }
            out += ns.substring(with: NSRange(location: cursor, length: start - cursor))
            out += "[HIDDEN]"
            covered += end - start
            cursor = end
        }
        out += ns.substring(from: cursor)
        return (out, Double(covered) / Double(max(1, ns.length)))
    }

    // MARK: - AI text classification

    static func lineQuestion(key: String, hide: String, keep: String) -> JSONValue {
        Question.noul(
            .string("Does the text of `screen.\(key)` contain something described under true? Judge only that one line; the lines around it are context."),
            criteria: [
                "true": .string("The line contains any of: \(hide). A bare label such as \"Password\" with no value is not sensitive; the value is."),
                "false": .string("The line contains only: \(keep). Text shown as [HIDDEN] was already removed and is not sensitive."),
            ])
    }

    func classifyLines(lines: [OCRLine], maskedText: [String], client: JevClient,
                       warnings: inout [String]) async throws -> [(Int, Double)] {
        var candidates: [Int] = []
        for i in lines.indices {
            let alnum = maskedText[i].replacingOccurrences(of: "[HIDDEN]", with: "").filter { $0.isLetter || $0.isNumber }.count
            if alnum >= 2 { candidates.append(i) }
        }
        if candidates.count > RedactionEngine.maxQuestionLines {
            if settings.abortIfAIUnavailable { throw JevError.badRequest("Too many text lines to complete the required AI check.") }
            warnings.append("Screenshot has \(candidates.count) text lines; AI-checked the first \(RedactionEngine.maxQuestionLines).")
            candidates = Array(candidates.prefix(RedactionEngine.maxQuestionLines))
        }
        guard !candidates.isEmpty else { return [] }

        let groups = stride(from: 0, to: candidates.count, by: RedactionEngine.linesPerRequest).map {
            Array(candidates[$0..<min($0 + RedactionEngine.linesPerRequest, candidates.count)])
        }
        let hide = settings.aiHideRules, keep = settings.aiKeepRules
        let threshold = settings.aiThreshold
        let model = settings.textModel

        var requests: [JevRequest] = []
        var targets: [[Int]] = []
        for group in groups {
            var context = Set<Int>()
            for idx in group {
                context.formUnion(max(0, idx - RedactionEngine.contextLines)...min(lines.count - 1, idx + RedactionEngine.contextLines))
            }
            var screen: [String: JSONValue] = [:]
            for i in context.sorted() { screen["L\(i)"] = .string(maskedText[i]) }
            var questions: [String: JSONValue] = [:]
            for i in group { questions["L\(i)"] = RedactionEngine.lineQuestion(key: "L\(i)", hide: hide, keep: keep) }
            let state: JSONValue = [
                "about": "Text recognized in a screenshot, one entry per line in reading order. [HIDDEN] marks text that was already removed.",
                "screen": .object(screen),
            ]
            requests.append(JevRequest(model: model, state: state, questions: questions))
            targets.append(group)
        }

        // Run in small waves so we don't hammer rate limits.
        var flagged: [(Int, Double)] = []
        var failure: Error?
        var failedChunks = 0
        var start = 0
        while start < requests.count {
            let end = min(start + RedactionEngine.maxConcurrentRequests, requests.count)
            await withTaskGroup(of: (Int, Result<JevResponse, Error>).self) { tg in
                for i in start..<end {
                    let req = requests[i]
                    tg.addTask {
                        do { return (i, .success(try await client.systemOne(req))) } catch { return (i, .failure(error)) }
                    }
                }
                for await (i, result) in tg {
                    switch result {
                    case .success(let resp):
                        for idx in targets[i] {
                            if case .noul(let p)? = resp.answers["L\(idx)"], p >= threshold { flagged.append((idx, p)) }
                        }
                    case .failure(let e):
                        failedChunks += 1
                        failure = failure ?? e
                    }
                }
            }
            start = end
        }
        if let failure = failure {
            if failedChunks == requests.count { throw failure }
            warnings.append("\(failedChunks) of \(requests.count) AI requests failed (\(failure.localizedDescription)); some lines were only checked by local rules.")
            if settings.abortIfAIUnavailable { throw failure }
        }
        return flagged.sorted { $0.0 < $1.0 }
    }

    // Locate sensitive words using text only; keep a full-line fallback if localization is incomplete.
    private func refineSensitiveWords(lines: [OCRLine], maskedText: [String], flagged: [(Int, Double)],
                                      detector: LocalDetector, client: JevClient,
                                      warnings: inout [String]) async throws -> [Finding] {
        struct Word { let line: Int; let range: NSRange; let text: String }
        struct Span { var start: Int; var end: Int; var probability: Double }
        let regex = try! NSRegularExpression(pattern: #"[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*"#)
        var words: [Word] = []
        var fallback = Set<Int>()
        for (idx, _) in flagged {
            let text = lines[idx].text as NSString
            let local = detector.matches(in: lines[idx].text)
            let tokens = regex.matches(in: lines[idx].text, range: NSRange(location: 0, length: text.length))
                .filter { token in !local.contains { NSIntersectionRange($0.range, token.range).length > 0 } }
                .map { Word(line: idx, range: $0.range, text: text.substring(with: $0.range)) }
            if tokens.isEmpty || words.count + tokens.count > 1600 { fallback.insert(idx) }
            else { words.append(contentsOf: tokens) }
        }
        var requests: [JevRequest] = []
        var groups: [[Int]] = []
        for start in stride(from: 0, to: words.count, by: 80) {
            let ids = Array(start..<min(start + 80, words.count))
            var screen: [String: JSONValue] = [:]
            var candidates: [String: JSONValue] = [:]
            var questions: [String: JSONValue] = [:]
            for id in ids {
                let word = words[id]
                screen["L\(word.line)"] = .string(maskedText[word.line])
                candidates["W\(id)"] = ["text": .string(word.text), "line": .string("L\(word.line)")]
                questions["W\(id)"] = Question.noul(
                    .string("Should only the word in `words.W\(id).text` be hidden? Read `screen.L\(word.line)` for context. " +
                            "Judge this word, not the entire sentence. For a name or other multi-word sensitive value, judge whether this word belongs to that value."),
                    criteria: ["true": .string("This word is part of sensitive information: \(settings.aiHideRules)."),
                               "false": .string("This word is ordinary wording, an action, a connector, a label, or: \(settings.aiKeepRules). [HIDDEN] is already removed.")])
            }
            requests.append(JevRequest(model: settings.textModel, state: ["screen": .object(screen), "words": .object(candidates)], questions: questions))
            groups.append(ids)
        }
        var hits: [Int: [Span]] = [:]
        for start in stride(from: 0, to: requests.count, by: Self.maxConcurrentRequests) {
            var failure: Error?
            await withTaskGroup(of: (Int, Result<JevResponse, Error>).self) { group in
                for i in start..<min(start + Self.maxConcurrentRequests, requests.count) {
                    let request = requests[i]
                    group.addTask {
                        do { return (i, .success(try await client.systemOne(request))) }
                        catch { return (i, .failure(error)) }
                    }
                }
                for await (i, response) in group {
                    switch response {
                    case .failure(let error):
                        failure = failure ?? error
                        for id in groups[i] { fallback.insert(words[id].line) }
                    case .success(let response):
                        for id in groups[i] {
                            if case .noul(let probability)? = response.answers["W\(id)"], probability >= settings.aiThreshold {
                                let word = words[id]
                                hits[word.line, default: []].append(Span(start: word.range.location,
                                    end: NSMaxRange(word.range), probability: probability))
                            }
                        }
                    }
                }
            }
            if let failure = failure, settings.abortIfAIUnavailable { throw failure }
        }
        var findings: [Finding] = []
        for (idx, probability) in flagged {
            let selected = (hits[idx] ?? []).sorted { $0.start < $1.start }
            if fallback.contains(idx) || selected.isEmpty {
                fallback.insert(idx)
                findings.append(Finding(rect: lines[idx].rect, category: Self.aiCategory, source: .ai, confidence: probability))
                continue
            }
            var spans: [Span] = []
            let text = lines[idx].text as NSString
            for word in selected {
                if let previous = spans.last,
                   text.substring(with: NSRange(location: previous.end, length: word.start - previous.end))
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    spans[spans.count - 1].end = word.end
                    spans[spans.count - 1].probability = min(previous.probability, word.probability)
                } else { spans.append(word) }
            }
            for span in spans {
                findings.append(Finding(rect: lines[idx].rect(for: NSRange(location: span.start, length: span.end - span.start)),
                                        category: Self.aiCategory, source: .ai, confidence: span.probability))
            }
        }
        if !fallback.isEmpty { warnings.append("Some sensitive text could not be located precisely; those lines were hidden in full.") }
        return findings
    }

    // MARK: - Visual (Box)

    func visualFindings(payload: ImagePayload, client: JevClient) async throws -> ([Finding], [String]) {
        let ref = UUID().uuidString
        if settings.visualTargets.count > RedactionEngine.maxVisualTargets && settings.abortIfAIUnavailable {
            throw JevError.badRequest("Too many visual targets to complete the required AI check.")
        }
        let targets = Array(settings.visualTargets.prefix(RedactionEngine.maxVisualTargets))
        var questions: [String: JSONValue] = [:]
        for (i, t) in targets.enumerated() {
            // Box has no "not found" answer, so each target also gets a yes/no and a count question.
            questions["seen\(i)"] = Question.noul(.string("Is there \(t) in `screenshot`?"))
            questions["box\(i)"] = Question.box(.string("\(t) in `screenshot`"))
            questions["count\(i)"] = Question.choice(
                .string("How many separate instances of \(t) are in `screenshot`?"),
                criteria: ["none": .string("There are none."), "one": .string("There is exactly one."),
                           "several": .string("There are two or more.")])
        }
        let request = JevRequest(
            model: settings.visualModel,
            state: ["screenshot": .string(ref)],
            questions: questions,
            assets: [ref: ["type": "image", "format": .string(payload.format), "data_base64": .string(payload.data.base64EncodedString())]])
        let response = try await client.systemOne(request)

        var findings: [Finding] = []
        var warnings: [String] = settings.visualTargets.count > RedactionEngine.maxVisualTargets
            ? ["Only the first 8 visual targets were checked."] : []
        for (i, t) in targets.enumerated() {
            guard case .noul(let seen)? = response.answers["seen\(i)"], seen >= settings.aiThreshold,
                  case .box(let rect, let conf)? = response.answers["box\(i)"],
                  conf >= settings.visualMinConfidence else { continue }
            findings.append(Finding(rect: rect, category: "Visual: \(t)", source: .visual, confidence: conf))
            if case .choice("several", _, _)? = response.answers["count\(i)"] {
                warnings.append("More than one match for \"\(t)\"; Box returns a single region, so only one was hidden.")
            }
        }
        return (findings, warnings)
    }
}
