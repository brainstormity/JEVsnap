import AppKit
import Combine
import ServiceManagement
import JEVsnapCore
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = SettingsStore.shared
    private var statusItem: NSStatusItem?
    private var statusLine: NSMenuItem?
    private var revealItem: NSMenuItem?
    private var regionItem: NSMenuItem?
    private var settingsWindow: NSWindow?
    private var cancellables = Set<AnyCancellable>()
    private var busy = false
    private var lastCaptureURL: URL?
    private var activeHotKey: HotKeySetting?
    private var permissionAlertShown = false

    private static let onboardedKey = "jevsnap.didOnboard"

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildStatusItem()
        Notifier.requestAuthorization()

        HotKeyManager.shared.onTrigger = { [weak self] in self?.startCapture(.region) }
        applyHotKey(store.settings.hotKey)
        store.$settings.map(\.hotKey).removeDuplicates()
            .sink { [weak self] hk in self?.applyHotKey(hk) }.store(in: &cancellables)
        store.$settings.map(\.launchAtLogin).removeDuplicates()
            .sink { [weak self] on in self?.applyLaunchAtLogin(on) }.store(in: &cancellables)

        if !UserDefaults.standard.bool(forKey: Self.onboardedKey) {
            UserDefaults.standard.set(true, forKey: Self.onboardedKey)
            openSettings()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        HotKeyManager.shared.unregister()
    }

    // MARK: - Menu bar

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "eye.slash", accessibilityDescription: "JEVsnap")
        item.button?.toolTip = "JEVsnap — redacting screenshots"

        let menu = NSMenu()
        let region = NSMenuItem(title: "Capture Region", action: #selector(captureRegion), keyEquivalent: "")
        region.target = self
        regionItem = region
        menu.addItem(region)
        for (title, sel) in [("Capture Window", #selector(captureWindow)), ("Capture Full Screen", #selector(captureFullScreen))] {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
            i.target = self
            menu.addItem(i)
        }
        menu.addItem(.separator())

        let status = NSMenuItem(title: "No captures yet", action: nil, keyEquivalent: "")
        status.isEnabled = false
        statusLine = status
        menu.addItem(status)

        let reveal = NSMenuItem(title: "Reveal Last Screenshot in Finder", action: #selector(revealLast), keyEquivalent: "")
        reveal.target = self
        reveal.isEnabled = false
        revealItem = reveal
        menu.addItem(reveal)

        let folder = NSMenuItem(title: "Open Screenshots Folder", action: #selector(openFolder), keyEquivalent: "")
        folder.target = self
        menu.addItem(folder)
        menu.addItem(.separator())

        let permission = NSMenuItem(title: "Screen Recording Permission…", action: #selector(permissionHelp), keyEquivalent: "")
        permission.target = self
        menu.addItem(permission)

        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettingsAction), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(NSMenuItem(title: "Quit JEVsnap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        item.menu = menu
        statusItem = item
        updateRegionTitle(store.settings.hotKey)
    }

    private func updateRegionTitle(_ hk: HotKeySetting) {
        regionItem?.title = "Capture Region    \(hk.displayString)"
    }

    private func setBusy(_ on: Bool) {
        busy = on
        let name = on ? "hourglass" : "eye.slash"
        statusItem?.button?.image = NSImage(systemSymbolName: name, accessibilityDescription: "JEVsnap")
    }

    @objc private func captureRegion() { startCapture(.region) }
    @objc private func captureWindow() { startCapture(.window) }
    @objc private func captureFullScreen() { startCapture(.fullScreen) }
    @objc private func openSettingsAction() { openSettings() }
    @objc private func permissionHelp() { showPermissionAlert() }

    @objc private func revealLast() {
        guard let url = lastCaptureURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @objc private func openFolder() {
        let url = store.saveFolderURL
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    // MARK: - Settings window

    func openSettings() {
        if settingsWindow == nil {
            let hosting = NSHostingController(rootView: SettingsView(store: store))
            let window = NSWindow(contentViewController: hosting)
            window.title = "JEVsnap Settings"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.setContentSize(NSSize(width: 620, height: 560))
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    // MARK: - Hotkey / login item

    private func applyHotKey(_ hk: HotKeySetting) {
        if HotKeyManager.shared.register(keyCode: hk.keyCode, modifiers: hk.modifiers) {
            activeHotKey = hk
            updateRegionTitle(hk)
        } else {
            Notifier.post(title: "JEVsnap", body: "Could not register \(hk.displayString). Choose another shortcut in Settings.")
            if let previous = activeHotKey {
                updateRegionTitle(previous)
                // Settings are published in willSet; defer rollback until that write completes.
                Task { @MainActor [weak self] in
                    guard let self = self, self.store.settings.hotKey == hk else { return }
                    self.store.settings.hotKey = previous
                }
            }
        }
    }

    private func applyLaunchAtLogin(_ on: Bool) {
        let service = SMAppService.mainApp
        do {
            if on, service.status != .enabled { try service.register() }
            if !on, service.status == .enabled { try service.unregister() }
        } catch {
            NSLog("JEVsnap: launch-at-login change failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Capture flow

    private func startCapture(_ mode: ScreenCapture.Mode) {
        guard !busy else { return }
        let settings = store.settings
        let apiKey = store.effectiveAPIKey
        let folder = store.saveFolderURL
        setBusy(true)

        Task {
            defer { setBusy(false) }
            do {
                guard try await ScreenCapture.ensurePermission() else {
                    reportPermissionDenied()
                    return
                }
                let temporary = try TemporaryCapture()
                defer { try? temporary.cleanup() }
                let wasVisible = settingsWindow?.isVisible == true
                if wasVisible { settingsWindow?.orderOut(nil) }
                let captured: Bool
                do {
                    defer { if wasVisible { settingsWindow?.makeKeyAndOrderFront(nil) } }
                    if wasVisible { try await Task.sleep(nanoseconds: 200_000_000) }
                    captured = try await ScreenCapture.capture(mode, to: temporary.imageURL)
                }
                guard captured else { return } // cancelled
                permissionAlertShown = false
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.imageURL.path)

                statusLine?.title = "Redacting…"
                let processed = try await Task.detached(priority: .userInitiated) {
                    try await CaptureProcessor.process(imageURL: temporary.imageURL, settings: settings, apiKey: apiKey)
                }.value

                // Remove the raw capture before persisting the completed image.
                try temporary.cleanup()
                let savedURL = try CaptureStorage.save(processed.redactedPNG, in: folder,
                                                       hasRedactions: !processed.result.rects.isEmpty)
                if settings.copyToClipboard { ImageTools.copyToClipboard(pngData: processed.redactedPNG) }
                lastCaptureURL = savedURL
                revealItem?.isEnabled = true
                report(processed, settings: settings)
            } catch ScreenCapture.CaptureError.permissionDenied {
                reportPermissionDenied()
            } catch {
                statusLine?.title = "Last capture failed"
                let body = "\(error.localizedDescription) Nothing was copied to the clipboard."
                Notifier.post(title: "JEVsnap: redaction failed", body: body)
                NSSound(named: NSSound.Name("Basso"))?.play()
            }
        }
    }

    private func report(_ p: ProcessedCapture, settings: AppSettings) {
        let total = p.result.findings.count
        let summary = p.result.summary.sorted { $0.value > $1.value }.map { "\($0.value)× \($0.key)" }.joined(separator: ", ")
        var headline = total == 0 ? "No sensitive info found" : "Hid \(total) item\(total == 1 ? "" : "s")"
        if settings.copyToClipboard { headline += " · copied" }
        statusLine?.title = headline

        var body = total == 0 ? "Nothing to hide (\(p.ocrLineCount) text lines checked)." : summary
        if !p.result.warnings.isEmpty { body += "\n⚠︎ " + p.result.warnings.joined(separator: " ") }
        if settings.showNotifications { Notifier.post(title: "JEVsnap: \(headline)", body: body) }
        if settings.playSound { NSSound(named: NSSound.Name("Glass"))?.play() }
    }

    private func reportPermissionDenied() {
        statusLine?.title = "Screen Recording access unavailable"
        if !permissionAlertShown {
            permissionAlertShown = true
            showPermissionAlert()
        }
    }

    private func showPermissionAlert() {
        let alert = NSAlert()
        alert.messageText = "Screen Recording access needs attention"
        alert.informativeText = "An enabled entry may belong to an older build or another copy. In System Settings → Privacy & Security → Screen Recording, remove the stale entry and add this JEVsnap app:\n\n" +
            Bundle.main.bundleURL.path + "\n\nQuit all running copies, enable this app, then reopen it. Ad-hoc signed rebuilds may need a new grant; a stable Apple signing certificate preserves the app identity across updates."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Reveal This App")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        } else if response == .alertSecondButtonReturn {
            NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
        }
    }
}
