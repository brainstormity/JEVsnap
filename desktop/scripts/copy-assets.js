// Copies static renderer files (HTML/CSS) next to the compiled renderer JS, and icons into dist/assets.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (filter(e.name)) fs.copyFileSync(s, d);
  }
}
copyDir(path.join(root, "src", "renderer"), path.join(root, "dist", "renderer"), (n) => !n.endsWith(".ts"));
copyDir(path.join(root, "assets"), path.join(root, "dist", "assets"));
