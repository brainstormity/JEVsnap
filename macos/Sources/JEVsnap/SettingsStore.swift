import Foundation
import JEVsnapCore

@MainActor
final class SettingsStore: ObservableObject {
    static let shared = SettingsStore()

    private static let defaultsKey = "jevsnap.settings.v1"
    private static let keychainAccount = "typesafe-api-key"

    @Published var settings: AppSettings {
        didSet { persist() }
    }

    @Published private(set) var keychainWarning: String?

    /// Held in the Keychain, not in the settings JSON.
    @Published var apiKey: String {
        didSet {
            guard apiKey != oldValue else { return }
            let saved = Keychain.set(apiKey.trimmingCharacters(in: .whitespacesAndNewlines), account: Self.keychainAccount)
            keychainWarning = saved ? nil : "Could not update the Keychain. Your change applies only to this session; a previously saved key may still exist."
        }
    }

    init() {
        let savedSettings = UserDefaults.standard.data(forKey: Self.defaultsKey)
        if let data = savedSettings,
           let decoded = try? JSONDecoder().decode(AppSettings.self, from: data) {
            settings = decoded
        } else {
            settings = AppSettings()
        }
        apiKey = Keychain.get(account: Self.keychainAccount) ?? ""
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }

    /// The key from Settings, or the TYPESAFE_API_KEY environment variable as a fallback.
    var effectiveAPIKey: String {
        let k = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !k.isEmpty { return k }
        return ProcessInfo.processInfo.environment["TYPESAFE_API_KEY"] ?? ""
    }

    var saveFolderURL: URL {
        URL(fileURLWithPath: (settings.saveFolderPath as NSString).expandingTildeInPath, isDirectory: true)
    }
}
