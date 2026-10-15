# Contributing

- Detection logic lives in `macos/Sources/JEVsnapCore` (Swift) and `desktop/src/core` (TypeScript). Change both and add a case to
  `shared/detector-cases.json`; both test suites run it.
- `swift test` in `macos/`, `npm test` in `desktop/`.
- Never log or store sensitive text. `Finding` deliberately has no text field.
- Offline API testing: `python3 tools/mock_jev_server.py` (macOS live test: `JEVSNAP_TEST_SERVER=http://127.0.0.1:8765`).
- Keep secret-shaped literals out of the repo (build them from fragments in tests) so secret scanners stay quiet.

- Gitleaks scans the code and Git history in CI. `.gitleaks.toml` narrowly excludes known synthetic
  fixture values in specific historical test commits; do not add blanket exclusions for tests or source folders.
- Captures are persisted only after processing, in `Redacted/` or `Not Redacted/`. Never add original-image
  retention or commit local screenshots, `.env` files, API keys, or keystore/settings files.
