#!/usr/bin/env bash
# Use a stable Apple identity when available; never weaken the designated requirement to bypass TCC.
set -euo pipefail
APP="${1:?usage: sign-app.sh APP [PREVIOUS_APP]}"
PREVIOUS_APP="${2:-}"
explicit_identity="${SIGN_IDENTITY+x}"
selected_identity="${SIGN_IDENTITY:-}"
if [[ -z "$selected_identity" ]]; then
  available_identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  selected_identity="$(printf '%s\n' "$available_identities" | awk '/"Developer ID Application:/ {print $2; exit}')"
  if [[ -z "$selected_identity" ]]; then
    selected_identity="$(printf '%s\n' "$available_identities" | awk '/"Apple Development:|"Mac Developer:/ {print $2; exit}')"
  fi
  selected_identity="${selected_identity:--}"
fi
if [[ "$selected_identity" == "-" ]]; then
  if [[ -z "$explicit_identity" && -n "$PREVIOUS_APP" && -d "$PREVIOUS_APP" ]] &&
     codesign -d --verbose=4 "$PREVIOUS_APP" 2>&1 | /usr/bin/grep -q '^Authority='; then
    echo "Refusing to replace a certificate-signed app with an ad-hoc build. Unlock the signing keychain or set SIGN_IDENTITY explicitly." >&2
    exit 1
  fi
  echo "WARNING: ad-hoc signing. macOS may require Screen Recording permission again after a rebuild." >&2
  echo "For permissions that persist across updates, set SIGN_IDENTITY to a stable Apple Development or Developer ID Application certificate." >&2
fi
codesign --force --sign "$selected_identity" --identifier dev.jevsnap.app "$APP"
codesign --verify --strict "$APP"
