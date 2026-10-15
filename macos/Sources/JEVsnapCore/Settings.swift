import Foundation

/// Categories handled by the local (offline, deterministic) detectors.
public enum DetectorKind: String, Codable, CaseIterable, Sendable {
    case email, phone, creditCard, ssn, ipAddress
    case knownToken, jwt, privateKey, bearerToken, credentialAssignment, urlCredentials
    case highEntropy, homePath

    public var title: String {
        switch self {
        case .email: return "Email addresses"
        case .phone: return "Phone numbers"
        case .creditCard: return "Credit card numbers"
        case .ssn: return "US Social Security numbers"
        case .ipAddress: return "IPv4 addresses"
        case .knownToken: return "API keys (AWS, GitHub, Slack, Stripe, OpenAI…)"
        case .jwt: return "JWT tokens"
        case .privateKey: return "Private key headers"
        case .bearerToken: return "Bearer tokens"
        case .credentialAssignment: return "password= / token= / secret= values"
        case .urlCredentials: return "Passwords inside URLs"
        case .highEntropy: return "Long random-looking strings"
        case .homePath: return "Usernames in file paths (/Users/…)"
        }
    }
}

/// Global hotkey. `modifiers` uses Carbon masks so it can be passed straight to
/// RegisterEventHotKey: cmd=256, shift=512, option=2048, control=4096.
public struct HotKeySetting: Codable, Equatable, Sendable {
    public static let cmd: UInt32 = 256
    public static let shift: UInt32 = 512
    public static let option: UInt32 = 2048
    public static let control: UInt32 = 4096

    public var keyCode: UInt32
    public var modifiers: UInt32
    public var label: String

    public init(keyCode: UInt32, modifiers: UInt32, label: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.label = label
    }

    /// Cmd+Shift+6 — unused by macOS's built-in screenshot shortcuts (3/4/5).
    public static let `default` = HotKeySetting(keyCode: 22, modifiers: cmd | shift, label: "6")

    public var displayString: String {
        var s = ""
        if modifiers & HotKeySetting.control != 0 { s += "⌃" }
        if modifiers & HotKeySetting.option != 0 { s += "⌥" }
        if modifiers & HotKeySetting.shift != 0 { s += "⇧" }
        if modifiers & HotKeySetting.cmd != 0 { s += "⌘" }
        return s + label.uppercased()
    }
}

public struct AppSettings: Codable, Equatable, Sendable {
    // General
    public var saveFolderPath: String = "~/Pictures/JEVsnap"
    public var copyToClipboard: Bool = true
    public var playSound: Bool = true
    public var showNotifications: Bool = true
    public var launchAtLogin: Bool = false
    public var hotKey: HotKeySetting = .default

    // Jev API
    public var apiBaseURL: String = "https://api.typesafe.ai"
    public var textModel: String = "jev-latest"
    public var visualModel: String = "jev-preview"
    public var requestTimeoutSeconds: Double = 30

    // Local detection
    public var enabledDetectors: Set<DetectorKind> = Set(DetectorKind.allCases)
    public var detectFaces: Bool = true
    public var detectBarcodes: Bool = true
    public var customPhrasesText: String = ""    // one per line, always hidden
    public var customRegexesText: String = ""    // one per line
    public var allowlistText: String = ""        // one per line, never hidden
    public var paddingPixels: Double = 4

    // AI text check (sends OCR text — not the image — to Jev)
    public var aiEnabled: Bool = true
    public var aiHideRules: String = AppSettings.defaultHideRules
    public var aiKeepRules: String = AppSettings.defaultKeepRules
    /// Lower = hides more. A line is hidden when Jev's yes-probability >= this.
    public var aiThreshold: Double = 0.5
    /// When true, a failed AI check aborts the capture instead of falling back to local rules.
    public var abortIfAIUnavailable: Bool = false

    // Visual check (sends the already-redacted image to Jev Box). Off by default.
    public var visualEnabled: Bool = false
    public var visualTargetsText: String = "a person's face or profile photo\na handwritten signature"
    public var visualMinConfidence: Double = 0.5

    public static let defaultHideRules =
        "personal names of private individuals; personal email addresses, phone numbers and street addresses; " +
        "usernames, account IDs and customer, employee or patient data; passwords, tokens, API keys, secrets " +
        "and recovery codes; internal hostnames, internal URLs and private network addresses; financial " +
        "account numbers and balances"
    public static let defaultKeepRules =
        "generic interface text such as menus, buttons, labels and headings; source code and shell commands " +
        "that contain no secrets; public product, company and brand names; public documentation text"

    public init() {}

    private enum CodingKeys: String, CodingKey {
        case saveFolderPath, copyToClipboard, playSound, showNotifications, launchAtLogin, hotKey
        case apiBaseURL, textModel, visualModel, requestTimeoutSeconds
        case enabledDetectors, detectFaces, detectBarcodes, customPhrasesText, customRegexesText, allowlistText, paddingPixels
        case aiEnabled, aiHideRules, aiKeepRules, aiThreshold, abortIfAIUnavailable
        case visualEnabled, visualTargetsText, visualMinConfidence
    }

    /// Tolerant decoding: missing keys fall back to defaults so settings saved by an
    /// older version keep working after an upgrade.
    public init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func get<T: Decodable>(_ key: CodingKeys, _ keyPath: WritableKeyPath<AppSettings, T>) {
            if let v = try? c.decodeIfPresent(T.self, forKey: key) { self[keyPath: keyPath] = v }
        }
        get(.saveFolderPath, \.saveFolderPath)
        get(.copyToClipboard, \.copyToClipboard)
        get(.playSound, \.playSound)
        get(.showNotifications, \.showNotifications)
        get(.launchAtLogin, \.launchAtLogin)
        get(.hotKey, \.hotKey)
        get(.apiBaseURL, \.apiBaseURL)
        get(.textModel, \.textModel)
        get(.visualModel, \.visualModel)
        get(.requestTimeoutSeconds, \.requestTimeoutSeconds)
        get(.enabledDetectors, \.enabledDetectors)
        get(.detectFaces, \.detectFaces)
        get(.detectBarcodes, \.detectBarcodes)
        get(.customPhrasesText, \.customPhrasesText)
        get(.customRegexesText, \.customRegexesText)
        get(.allowlistText, \.allowlistText)
        get(.paddingPixels, \.paddingPixels)
        get(.aiEnabled, \.aiEnabled)
        get(.aiHideRules, \.aiHideRules)
        get(.aiKeepRules, \.aiKeepRules)
        get(.aiThreshold, \.aiThreshold)
        get(.abortIfAIUnavailable, \.abortIfAIUnavailable)
        get(.visualEnabled, \.visualEnabled)
        get(.visualTargetsText, \.visualTargetsText)
        get(.visualMinConfidence, \.visualMinConfidence)
        self = normalized()
    }

    public func normalized() -> AppSettings {
        var s = self
        func clamp(_ value: Double, _ low: Double, _ high: Double, _ fallback: Double) -> Double {
            value.isFinite ? min(high, max(low, value)) : fallback
        }
        s.aiThreshold = clamp(s.aiThreshold, 0.05, 0.99, 0.5)
        s.visualMinConfidence = clamp(s.visualMinConfidence, 0, 1, 0.5)
        s.paddingPixels = clamp(s.paddingPixels, 0, 50, 4)
        s.requestTimeoutSeconds = clamp(s.requestTimeoutSeconds, 5, 300, 30)
        return s
    }

    public static func lines(_ text: String) -> [String] {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
    public var customPhrases: [String] { AppSettings.lines(customPhrasesText) }
    public var customRegexes: [String] { AppSettings.lines(customRegexesText) }
    public var allowlist: [String] { AppSettings.lines(allowlistText) }
    public var visualTargets: [String] { AppSettings.lines(visualTargetsText) }
}
