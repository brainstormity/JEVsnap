import AppKit
import JEVsnapCore
import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        TabView {
            GeneralTab(store: store).tabItem { Label("General", systemImage: "gearshape") }
            APITab(store: store).tabItem { Label("API", systemImage: "key") }
            DetectionTab(store: store).tabItem { Label("Detection", systemImage: "text.magnifyingglass") }
            AITab(store: store).tabItem { Label("AI", systemImage: "sparkles") }
        }
        .frame(width: 620, height: 560)
        .padding(.top, 8)
    }
}

// MARK: - General

private struct GeneralTab: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        Form {
            Section("Screenshots folder") {
                HStack {
                    Text((store.settings.saveFolderPath as NSString).abbreviatingWithTildeInPath)
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Choose…") { chooseFolder() }
                    Button("Show") { showFolder() }
                }
                Text("Only processed screenshots are saved: in Redacted/ when something was hidden, or Not Redacted/ when no redactions were needed. Originals are never kept.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Shortcut") {
                HotKeyRecorder(hotKey: $store.settings.hotKey)
            }
            Section("Behavior") {
                Toggle("Copy the redacted screenshot to the clipboard", isOn: $store.settings.copyToClipboard)
                Toggle("Show a notification when done", isOn: $store.settings.showNotifications)
                Toggle("Play a sound when done", isOn: $store.settings.playSound)
                Toggle("Launch JEVsnap at login", isOn: $store.settings.launchAtLogin)
            }
        }
        .formStyle(.grouped)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.directoryURL = store.saveFolderURL
        if panel.runModal() == .OK, let url = panel.url {
            store.settings.saveFolderPath = url.path
        }
    }

    private func showFolder() {
        let url = store.saveFolderURL
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }
}

private struct HotKeyRecorder: View {
    @Binding var hotKey: HotKeySetting
    @State private var recording = false
    @State private var monitor: Any?
    @State private var hint = ""

    private static let specialLabels: [UInt16: String] = [
        49: "Space", 36: "↩", 48: "⇥", 51: "⌫", 123: "←", 124: "→", 125: "↓", 126: "↑",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6",
        98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]

    var body: some View {
        HStack {
            Text(recording ? "Press a shortcut…" : hotKey.displayString)
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6)
                    .fill(recording ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.15)))
            Button(recording ? "Cancel" : "Record") { recording ? stop() : start() }
            Button("Reset") { hotKey = .default }.disabled(recording)
            Text(hint).font(.caption).foregroundStyle(.secondary)
        }
        .onDisappear { stop() }
    }

    private func start() {
        recording = true
        hint = "Use ⌘, ⌃ or ⌥ with a key. Esc cancels."
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { stop(); return nil }   // Esc
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let mods = HotKeyManager.carbonModifiers(from: flags)
            let hasPrimary = mods & (HotKeySetting.cmd | HotKeySetting.option | HotKeySetting.control) != 0
            guard hasPrimary else { hint = "Include ⌘, ⌃ or ⌥."; return nil }
            let label = HotKeyRecorder.specialLabels[event.keyCode]
                ?? (event.charactersIgnoringModifiers ?? "?").uppercased()
            hotKey = HotKeySetting(keyCode: UInt32(event.keyCode), modifiers: mods, label: label)
            stop()
            return nil
        }
    }

    private func stop() {
        if let m = monitor { NSEvent.removeMonitor(m) }
        monitor = nil
        recording = false
        hint = ""
    }
}

// MARK: - API

private struct APITab: View {
    @ObservedObject var store: SettingsStore
    @State private var testing = false
    @State private var status = ""
    @State private var statusOK = false

    var body: some View {
        Form {
            Section("TypeSafe API key") {
                SecureField("API key", text: $store.apiKey)
                if let warning = store.keychainWarning {
                    Text(warning).font(.caption).foregroundStyle(.red)
                }
                HStack {
                    Button("Test connection") { testConnection() }
                        .disabled(testing || store.effectiveAPIKey.isEmpty)
                    if testing { ProgressView().controlSize(.small) }
                    Text(status).font(.caption).foregroundStyle(statusOK ? Color.green : Color.red)
                }
                Text("Stored in your macOS Keychain, never in a file. Without a key JEVsnap still works using on-device rules only.")
                    .font(.caption).foregroundStyle(.secondary)
                Link("Get a key at console.typesafe.ai", destination: URL(string: "https://console.typesafe.ai")!)
                    .font(.caption)
            }
            Section("Models") {
                TextField("Text model", text: $store.settings.textModel)
                TextField("Visual (Box) model", text: $store.settings.visualModel)
                Text("Box needs jev-preview or jev-1.14.0. Aliases like jev-preview move when new models ship; pin a version (e.g. jev-1.14.0) for stable behavior.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Advanced") {
                TextField("API base URL", text: $store.settings.apiBaseURL)
                Stepper("Request timeout: \(Int(store.settings.requestTimeoutSeconds)) s",
                        value: $store.settings.requestTimeoutSeconds, in: 5...120, step: 5)
            }
            Section("What leaves your Mac") {
                Text("Default: only the recognized text of the screenshot, with anything matched by local rules replaced by [HIDDEN]. The image itself is never uploaded unless you enable the visual check on the AI tab — and then only after everything found so far has been blacked out.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func testConnection() {
        testing = true
        status = ""
        let key = store.effectiveAPIKey
        let base = store.settings.apiBaseURL
        let timeout = store.settings.requestTimeoutSeconds
        Task { @MainActor in
            do {
                let client = try JevClient(apiKey: key, baseURL: base, timeout: timeout, maxRetries: 1)
                let models = try await client.listModels()
                statusOK = true
                status = "Connected ✓ (\(models.count) models available)"
            } catch {
                statusOK = false
                status = error.localizedDescription
            }
            testing = false
        }
    }
}

// MARK: - Detection

private struct DetectionTab: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        Form {
            Section("Detect on-device (offline, always runs)") {
                ForEach(DetectorKind.allCases, id: \.self) { kind in
                    Toggle(kind.title, isOn: binding(for: kind))
                }
            }
            Section("Images (on-device)") {
                Toggle("Faces", isOn: $store.settings.detectFaces)
                Toggle("QR codes and barcodes", isOn: $store.settings.detectBarcodes)
            }
            Section("Your own rules") {
                LabeledEditor(title: "Always hide these phrases (one per line, case-insensitive)",
                              text: $store.settings.customPhrasesText)
                LabeledEditor(title: "Always hide matches of these regular expressions (one per line)",
                              text: $store.settings.customRegexesText)
                let bad = store.settings.customRegexes.filter { !LocalDetector.isValidRegex($0) }
                if !bad.isEmpty {
                    Text("Invalid pattern: " + bad.joined(separator: ", ")).font(.caption).foregroundStyle(.red)
                }
                LabeledEditor(title: "Never hide text containing these (one per line) — e.g. your own email",
                              text: $store.settings.allowlistText)
            }
            Section("Appearance") {
                Stepper("Padding around hidden areas: \(Int(store.settings.paddingPixels)) px",
                        value: $store.settings.paddingPixels, in: 0...30, step: 1)
            }
        }
        .formStyle(.grouped)
    }

    private func binding(for kind: DetectorKind) -> Binding<Bool> {
        Binding(
            get: { store.settings.enabledDetectors.contains(kind) },
            set: { on in
                if on { store.settings.enabledDetectors.insert(kind) } else { store.settings.enabledDetectors.remove(kind) }
            })
    }
}

// MARK: - AI

private struct AITab: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        Form {
            Section("AI text check (Jev)") {
                Toggle("Ask Jev about each line of text", isOn: $store.settings.aiEnabled)
                Text("Catches what rules can't: names, addresses, internal hostnames, customer data. Needs an API key. Falls back to on-device rules if the request fails.")
                    .font(.caption).foregroundStyle(.secondary)
                LabeledEditor(title: "Hide text that contains…", text: $store.settings.aiHideRules, height: 84)
                LabeledEditor(title: "Keep text that is only…", text: $store.settings.aiKeepRules, height: 64)
                HStack {
                    Text("Sensitivity")
                    Slider(value: $store.settings.aiThreshold, in: 0.1...0.9)
                    Text("hide if ≥ \(Int(store.settings.aiThreshold * 100))%").font(.caption).monospacedDigit()
                }
                Text("Lower hides more (and over-hides more). Higher hides only what Jev is sure about.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Cancel the capture if the AI check fails (instead of using on-device rules only)",
                       isOn: $store.settings.abortIfAIUnavailable)
                Button("Reset rules to defaults") {
                    store.settings.aiHideRules = AppSettings.defaultHideRules
                    store.settings.aiKeepRules = AppSettings.defaultKeepRules
                    store.settings.aiThreshold = 0.5
                }
            }
            Section("Visual check (Jev Box, experimental)") {
                Toggle("Look for things in the image itself", isOn: $store.settings.visualEnabled)
                Text("Uses Jev's preview image + Box features, which TypeSafe flags as not production-ready. Uploads a downscaled copy of the screenshot with everything already found blacked out. Box returns one region per target.")
                    .font(.caption).foregroundStyle(.secondary)
                LabeledEditor(title: "Targets (one per line, up to 8)", text: $store.settings.visualTargetsText)
                HStack {
                    Text("Min. confidence")
                    Slider(value: $store.settings.visualMinConfidence, in: 0.1...0.95)
                    Text("\(Int(store.settings.visualMinConfidence * 100))%").font(.caption).monospacedDigit()
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Shared

private struct LabeledEditor: View {
    let title: String
    @Binding var text: String
    var height: CGFloat = 56

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(height: height)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
        }
    }
}
