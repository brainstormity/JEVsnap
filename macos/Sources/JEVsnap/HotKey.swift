import AppKit
import Carbon.HIToolbox

/// Global hotkey via Carbon's RegisterEventHotKey. Unlike event taps, this needs no
/// Accessibility / Input Monitoring permission.
final class HotKeyManager {
    static let shared = HotKeyManager()

    var onTrigger: (() -> Void)?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var current: (keyCode: UInt32, modifiers: UInt32)?

    private static let handler: EventHandlerUPP = { _, _, _ in
        DispatchQueue.main.async { HotKeyManager.shared.onTrigger?() }
        return noErr
    }

    /// Returns false if the combination is already taken by the system or another app.
    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32) -> Bool {
        if let current = current, current.keyCode == keyCode && current.modifiers == modifiers { return true }
        if handlerRef == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), HotKeyManager.handler, 1, &spec, nil, &handlerRef)
            guard status == noErr else { return false }
        }
        let id = EventHotKeyID(signature: OSType(0x53485244), id: 1)   // 'SHRD'
        var replacement: EventHotKeyRef?
        let status = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &replacement)
        guard status == noErr else { return false }
        unregister()
        hotKeyRef = replacement
        current = (keyCode, modifiers)
        return true
    }

    func unregister() {
        current = nil
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
    }

    /// Converts AppKit modifier flags to the Carbon mask RegisterEventHotKey expects.
    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var m: UInt32 = 0
        if flags.contains(.command) { m |= UInt32(cmdKey) }
        if flags.contains(.shift) { m |= UInt32(shiftKey) }
        if flags.contains(.option) { m |= UInt32(optionKey) }
        if flags.contains(.control) { m |= UInt32(controlKey) }
        return m
    }
}
