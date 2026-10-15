import SwiftUI

@main
struct JEVsnapApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // JEVsnap is a menu-bar app; the real UI is created by AppDelegate.
        Settings { EmptyView() }
    }
}
