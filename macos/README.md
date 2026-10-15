# JEVsnap for macOS

A macOS menu-bar app that takes screenshots with a hotkey and **automatically blacks out secrets and personal
information** before the image reaches your clipboard: API keys, tokens, emails, phone numbers, names,
internal hostnames, faces, QR codes, and anything else you describe.

> Unofficial community project built on the [TypeSafe Jev](https://typesafe.ai) API. Not affiliated with TypeSafe.
> **Status: v0.2.** No automatic redactor is perfect. JEVsnap reduces the chance of leaking something in a
> screenshot; it does not replace a quick look before you post. See [Limitations](#limitations).

## How it works

```
 hotkey ─► screencapture ─► Apple Vision (on-device)
                                              ├─ OCR: text + positions
                                              ├─ faces, QR codes / barcodes
                                              ▼
              1. Local rules  (regex + validators: Luhn, entropy, …)      offline
              2. Jev text check  (one yes/no question per text line)      only text is sent
              3. Jev Box check   (optional, user-defined visual targets)  off by default
                                              ▼
                 black boxes drawn over every finding ─► save redacted ─► clipboard
```

- **Local rules always run** and work with no API key or network: emails, phones, Luhn-valid card numbers,
  SSNs, IPv4, AWS/GitHub/Slack/Stripe/OpenAI/… key formats, JWTs, `Bearer` tokens, `password=` style
  assignments, passwords in URLs, private-key headers, long random-looking strings, `/Users/<name>` paths,
  plus your own phrases and regexes, minus your allowlist.
- **The Jev text check** adds judgment rules can't: names, addresses, customer data, internal hostnames. Each
  OCR line becomes one `noul` (yes/no) question against a policy you can edit. When it is flagged, a follow-up
  pass locates the sensitive words, preserving ordinary surrounding text. This follows TypeSafe's "fan-out"
  pattern: batched, small, literal questions rather than one big prompt.
- **The Jev Box check** (opt-in, uses the experimental *images* and *box* features) looks for visual targets
  you list ("a handwritten signature", …). Box returns one region per question and has no "not found" answer,
  so JEVsnap pairs each Box with a yes/no gate and a none/one/several count.

### What leaves your Mac

| Mode | Sent to TypeSafe |
| --- | --- |
| No API key | Nothing. |
| Default (AI text check) | Only the OCR'd **text**, with everything the local rules matched already replaced by `[HIDDEN]`. The image is never uploaded. |
| Visual check enabled | Additionally a downscaled JPEG of the screenshot **with everything found so far already blacked out**. |

The API key is stored in the macOS Keychain. Only processed screenshots are saved: images with redactions
in `Redacted/`, and images needing no redactions in `Not Redacted/`. Raw captures use a private temporary
file that is removed after processing, cancellation, or failure. Redaction never writes sensitive text to logs or reports.

## Install & run (from source)

Requirements: macOS 13+, Xcode 15+ (or Command Line Tools with Swift 5.9+).

```bash
git clone https://github.com/brainstormity/JEVsnap.git
cd JEVsnap/macos
./scripts/build-app.sh   # native architecture, ad-hoc signed; ARCHS="arm64 x86_64" needs full Xcode
open build/JEVsnap.app
```

On first launch JEVsnap opens Settings. The default hotkey is **⌘⇧6** (⌘⇧3/4/5 belong to macOS).
Launch the packaged app with `open build/JEVsnap.app`; running `swift run JEVsnap` from Terminal can attribute
screen access to the terminal instead of the app.

### Screen Recording enabled but capture still asks for permission

macOS binds Screen Recording permission to the installed app's identity. An old enabled entry can be stale
after an ad-hoc signed rebuild, and another copy of the app can have a separate grant. JEVsnap checks actual
ScreenCaptureKit access before treating a failed CoreGraphics preflight as a denial, honors successful
permission requests, and avoids repeating its own permission alert on every capture.

For the renamed app, grant access to **JEVsnap**, not its predecessor:

1. Quit all running copies.
2. In System Settings → Privacy & Security → Screen Recording (or Screen & System Audio Recording), remove
   the stale entry, then add the actual `build/JEVsnap.app` with the **+** button and enable it.
3. Reopen that same app. The menu's **Screen Recording Permission…** item can reveal the running app's
   location so you can check the right copy.

If macOS still refuses access, you can reset only this app's grant, then add it again:

```bash
tccutil reset ScreenCapture dev.jevsnap.app
```

JEVsnap never resets or modifies macOS privacy permissions automatically.

### Keep permission across rebuilds

The build script automatically prefers an available Developer ID Application or Apple Development identity.
You can select a specific stable identity explicitly:

```bash
SIGN_IDENTITY="Apple Development: your identity" ./scripts/build-app.sh
```

Without a usable certificate the build is ad-hoc signed and prints a warning: macOS may require a new grant
after every rebuild. Renaming alone cannot fix that OS restriction. An existing certificate-signed app is
never silently replaced with an ad-hoc build; an explicit `SIGN_IDENTITY="-"` is required to allow a downgrade.
No signing key or certificate is committed to the repository.

JEVsnap uses its own settings and Keychain service. Enter your API key and preferences again when
switching from an earlier app identity. Existing captures and settings are left in their original locations.

## Settings

- **General** — screenshots folder (`Redacted/` or `Not Redacted/` according to the result),
  clipboard, notification, sound, launch at login, global shortcut recorder.
- **API** — TypeSafe API key (Keychain) with a *Test connection* button, models, base URL, timeout.
  `TYPESAFE_API_KEY` in the environment is used as a fallback.
- **Detection** — toggle each local detector, faces, QR codes, custom phrases, custom regexes, allowlist, padding.
- **AI** — enable the text check, edit the hide/keep policy, sensitivity, fail-closed mode; optional visual check.

## Limitations

- **OCR-bound.** Text that Vision can't read (tiny, stylized, low contrast) can't be redacted. Faces and QR
  codes are detected separately.
- **AI text findings are localized to words.** After flagging a line, Jev checks which words are sensitive.
  Only those spans are hidden. If localization fails or glyph geometry is unavailable, JEVsnap conservatively
  hides the affected whole word or line and reports a warning when localization was incomplete.
- **Box finds one region per target** and TypeSafe labels images/Box as not production-ready ("danger zone");
  their accuracy and request format can change. That's why the visual check is off by default.
- **Jev text model is literal.** Phrase your hide/keep rules as exact conditions. Test on your own screenshots
  and tune the sensitivity.
- **Fail-safe behavior.** If OCR or rendering fails, nothing is copied. If only the AI request fails, local
  rules still apply (or the capture is cancelled, if you enable that setting).
- Redaction is solid black, not blur or pixelation, because pixelated text can often be recovered.
- No review/preview step yet (see roadmap).

## Development

```bash
swift test                              # core logic; runs on Linux and macOS
python3 ../tools/mock_jev_server.py 8765 &
JEVSNAP_TEST_SERVER=http://127.0.0.1:8765 swift test --filter LiveTransportTests   # real HTTP, mocked API
```

- `Sources/JEVsnapCore` — platform-independent: detectors, Jev client, request building, the redaction engine.
- `Sources/JEVsnap` — macOS app: menu bar, hotkey, capture, Vision, image rendering, Keychain, SwiftUI settings.
- Tests cover the detectors (positive and negative cases), geometry and API image limits, the client (headers,
  retries, errors, parsing), and the engine (chunking, secret masking before send, fail-open/closed, Box gating).

## Roadmap

- Preview window: click to add/remove boxes before the image is copied
- Per-app profiles (strict in Terminal/browsers, off in design tools)
- Word-level boxes for AI findings
- Redact existing files / drag-and-drop, CLI, Shortcuts action
- Tile-based Box for many targets of the same kind

## License

MIT
