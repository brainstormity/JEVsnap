import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultSettings } from "../src/core/settings";

test("default capture folder uses the app name", () => {
  assert.equal(defaultSettings().saveFolderPath, "~/Pictures/JEVsnap");
});

const signScript = path.join(__dirname, "..", "..", "macos", "scripts", "sign-app.sh");
for (const scenario of ["stable", "adhoc", "no-downgrade"] as const) {
  test(`signing identity selection: ${scenario}`, { skip: process.platform === "win32" }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jevsnap-signing-"));
    try {
      const bin = path.join(root, "bin"), app = path.join(root, "JEVsnap.app"), previous = path.join(root, "previous.app");
      fs.mkdirSync(bin); fs.mkdirSync(app); fs.mkdirSync(previous);
      fs.writeFileSync(path.join(bin, "security"), '#!/bin/bash\nprintf "%s\\n" "$FAKE_IDENTITIES"\n', { mode: 0o700 });
      fs.writeFileSync(path.join(bin, "codesign"), `#!/bin/bash
if [[ "$1" == "-d" ]]; then
  if [[ "$FAKE_PREVIOUS_SIGNED" == "yes" ]]; then echo 'Authority=Developer ID Application: Example' >&2; fi
  exit 0
fi
if [[ "$1" == "--force" ]]; then printf '%s\\n' "$@" > "$SIGN_LOG"; fi
`, { mode: 0o700 });
      const log = path.join(root, "sign.log");
      const identity = "A".repeat(40);
      const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SIGN_LOG: log,
        FAKE_IDENTITIES: scenario === "stable" ? `1) ${identity} "Apple Development: Example"` : "0 valid identities found",
        FAKE_PREVIOUS_SIGNED: scenario === "no-downgrade" ? "yes" : "no" };
      delete env.SIGN_IDENTITY;
      if (scenario === "no-downgrade") {
        assert.throws(() => execFileSync("/bin/bash", [signScript, app, previous], { env, stdio: "pipe" }));
        assert.ok(!fs.existsSync(log));
      } else {
        execFileSync("/bin/bash", [signScript, app, previous], { env, stdio: "pipe" });
        const argumentsUsed = fs.readFileSync(log, "utf8").split("\n");
        assert.equal(argumentsUsed[2], scenario === "stable" ? identity : "-");
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
