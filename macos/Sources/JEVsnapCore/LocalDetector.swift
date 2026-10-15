import Foundation

public struct LocalMatch: Equatable {
    public var category: String
    public var range: NSRange   // UTF-16 range within the scanned text
}

/// Deterministic, offline detection of secrets and personal data in OCR text.
/// This layer works with no API key and no network.
public struct LocalDetector {
    private struct Rule {
        let kind: DetectorKind
        let regex: NSRegularExpression
        let group: Int
        let validator: ((String) -> Bool)?
    }

    private let rules: [Rule]
    private let customLiterals: [NSRegularExpression]
    private let customRegexes: [NSRegularExpression]
    private let allowlist: [String]

    /// Regexes in the settings that failed to compile (shown in the UI).
    public let invalidCustomRegexes: [String]

    public init(settings: AppSettings) {
        rules = LocalDetector.allRules.filter { settings.enabledDetectors.contains($0.kind) }
        customLiterals = settings.customPhrases.compactMap {
            try? NSRegularExpression(pattern: NSRegularExpression.escapedPattern(for: $0), options: [.caseInsensitive])
        }
        var good: [NSRegularExpression] = []
        var bad: [String] = []
        for pattern in settings.customRegexes {
            if let re = try? NSRegularExpression(pattern: pattern, options: []) { good.append(re) } else { bad.append(pattern) }
        }
        customRegexes = good
        invalidCustomRegexes = bad
        allowlist = settings.allowlist.map { $0.lowercased() }
    }

    public static func isValidRegex(_ pattern: String) -> Bool {
        (try? NSRegularExpression(pattern: pattern, options: [])) != nil
    }

    public func matches(in text: String) -> [LocalMatch] {
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        var out: [LocalMatch] = []

        func accept(_ category: String, _ range: NSRange) {
            guard range.location != NSNotFound, range.length > 0 else { return }
            let matched = ns.substring(with: range).lowercased()
            if allowlist.contains(where: { matched.contains($0) }) { return }
            out.append(LocalMatch(category: category, range: range))
        }

        for rule in rules {
            rule.regex.enumerateMatches(in: text, options: [], range: full) { m, _, _ in
                guard let m = m else { return }
                let r = m.range(at: rule.group)
                guard r.location != NSNotFound else { return }
                if let validator = rule.validator, !validator(ns.substring(with: r)) { return }
                accept(rule.kind.title, r)
            }
        }
        for re in customLiterals {
            re.enumerateMatches(in: text, options: [], range: full) { m, _, _ in
                if let m = m { accept("Custom phrase", m.range) }
            }
        }
        for re in customRegexes {
            re.enumerateMatches(in: text, options: [], range: full) { m, _, _ in
                if let m = m { accept("Custom pattern", m.range) }
            }
        }
        return out
    }

    // MARK: - Validators

    static func luhnValid(_ s: String) -> Bool {
        let d = s.filter { $0.isASCII && $0.isNumber }.compactMap { $0.wholeNumberValue }
        guard (13...19).contains(d.count) else { return false }
        var sum = 0
        for (i, v) in d.reversed().enumerated() {
            if i % 2 == 1 {
                let x = v * 2
                sum += x > 9 ? x - 9 : x
            } else {
                sum += v
            }
        }
        return sum % 10 == 0
    }

    static func plausiblePhone(_ s: String) -> Bool {
        let n = s.filter { $0.isASCII && $0.isNumber }.count
        return (10...15).contains(n)
    }

    static func plausibleSSN(_ s: String) -> Bool {
        let parts = s.split(separator: "-")
        guard parts.count == 3 else { return false }
        let area = String(parts[0]), group = String(parts[1]), serial = String(parts[2])
        return area != "000" && area != "666" && !area.hasPrefix("9") && group != "00" && serial != "0000"
    }

    static func plausibleIP(_ s: String) -> Bool {
        !["127.0.0.1", "0.0.0.0", "255.255.255.255"].contains(s)
    }

    static func shannonEntropy(_ s: String) -> Double {
        guard !s.isEmpty else { return 0 }
        var counts: [Character: Int] = [:]
        for ch in s { counts[ch, default: 0] += 1 }
        let n = Double(s.count)
        return -counts.values.reduce(0.0) { $0 + (Double($1) / n) * log2(Double($1) / n) }
    }

    static func looksLikeSecretBlob(_ s: String) -> Bool {
        guard s.count >= 32 else { return false }
        if s.filter({ $0 == "/" }).count > 2 { return false }
        if s.allSatisfy({ $0.isHexDigit }) { return false }          // git SHAs, checksums
        let hasDigit = s.contains { $0.isNumber }
        let hasLetter = s.contains { $0.isLetter }
        guard hasDigit && hasLetter else { return false }
        return shannonEntropy(s) >= 4.1
    }

    static func plausibleUser(_ s: String) -> Bool {
        !["shared", "public", "guest", "deleted users", "default"].contains(s.lowercased())
    }

    // MARK: - Rules

    private static func rule(_ kind: DetectorKind, _ pattern: String, group: Int = 0,
                             options: NSRegularExpression.Options = [],
                             validator: ((String) -> Bool)? = nil) -> Rule {
        // Patterns are compile-time constants; a failure here is a programmer error caught by tests.
        let re = try! NSRegularExpression(pattern: pattern, options: options)
        return Rule(kind: kind, regex: re, group: group, validator: validator)
    }

    private static let knownTokenPattern = [
        #"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b"#,
        #"\bgh[pousr]_[A-Za-z0-9]{30,}\b"#,
        #"\bgithub_pat_[A-Za-z0-9_]{20,}\b"#,
        #"\bglpat-[A-Za-z0-9_\-]{20,}"#,
        #"\bxox[abprs]-[A-Za-z0-9\-]{10,}"#,
        #"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b"#,
        #"\bwhsec_[A-Za-z0-9]{16,}\b"#,
        #"\bAIza[0-9A-Za-z_\-]{35}\b"#,
        #"\bsk-[A-Za-z0-9_\-]{20,}"#,
        #"\bnpm_[A-Za-z0-9]{30,}\b"#,
        #"\bhf_[A-Za-z0-9]{30,}\b"#,
        #"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}"#,
        #"\bdop_v1_[a-f0-9]{40,}\b"#,
    ].joined(separator: "|")

    private static let allRules: [Rule] = [
        rule(.email, #"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}"#),
        rule(.phone, #"(?<!\w)(?<!\d[\s.\-])(?<!\.)(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])\d{3,4}[\s.\-]\d{3,4}(?!\w)(?![\s.\-]\d)"#,
             validator: plausiblePhone),
        rule(.creditCard, #"(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)"#, validator: luhnValid),
        rule(.ssn, #"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"#, validator: plausibleSSN),
        rule(.ipAddress, #"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)(?!\.\d)"#,
             validator: plausibleIP),
        rule(.knownToken, knownTokenPattern),
        rule(.jwt, #"\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}"#),
        rule(.privateKey, #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#),
        rule(.bearerToken, #"\bbearer\s+([A-Za-z0-9._\-~+/]{16,}=*)"#, group: 1, options: [.caseInsensitive]),
        rule(.credentialAssignment,
             #"(?<![A-Za-z0-9])(?:api[_\- ]?key|apikey|secret(?:[_\- ]?key)?|access[_\- ]?token|auth[_\- ]?token|token|passwd|password|pwd|client[_\- ]?secret)(?![A-Za-z0-9])["']?\s*[:=]\s*["']?([^\s"'<>,;]{4,})"#,
             group: 1, options: [.caseInsensitive]),
        rule(.urlCredentials, #"\b[a-z][a-z0-9+.\-]*://[^\s/:@]+:([^\s/@]+)@"#, group: 1, options: [.caseInsensitive]),
        rule(.highEntropy, #"[A-Za-z0-9+/_=\-]{32,}"#, validator: looksLikeSecretBlob),
        rule(.homePath, #"(?:/Users/|/home/)([^/\s]+)"#, group: 1, validator: plausibleUser),
        rule(.homePath, #"[A-Za-z]:\\Users\\([^\\\s]+)"#, group: 1, validator: plausibleUser),
    ]
}
