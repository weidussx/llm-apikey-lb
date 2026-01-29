const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function rmIfExists(p) {
  if (!(await pathExists(p))) return;
  await fs.rm(p, { recursive: true, force: true });
}

function fail(msg) {
  process.stderr.write(String(msg) + "\n");
  process.exit(1);
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const distDir = path.join(root, "dist");
  const pkgJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const version = String(pkgJson.version || "0.0.0");

  const binArm64 = path.join(distDir, "llm-apikey-lb-macos-arm64");
  const binX64 = path.join(distDir, "llm-apikey-lb-macos-x64");
  if (!(await pathExists(binArm64))) fail(`missing binary: ${binArm64}`);
  if (!(await pathExists(binX64))) fail(`missing binary: ${binX64}`);

  const appName = "llm-apikey-lb.app";
  const appPath = path.join(distDir, appName);
  const contents = path.join(appPath, "Contents");
  const macosDir = path.join(contents, "MacOS");
  const resourcesDir = path.join(contents, "Resources");

  await rmIfExists(appPath);
  await fs.mkdir(macosDir, { recursive: true });
  await fs.mkdir(resourcesDir, { recursive: true });

  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>llm-apikey-lb</string>
    <key>CFBundleExecutable</key>
    <string>llm-apikey-lb</string>
    <key>CFBundleIdentifier</key>
    <string>com.weidussx.llm-apikey-lb</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>llm-apikey-lb</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>CFBundleVersion</key>
    <string>${version}</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>LSUIElement</key>
    <true/>
  </dict>
</plist>
`;
  await fs.writeFile(path.join(contents, "Info.plist"), infoPlist, "utf8");

  await fs.copyFile(binArm64, path.join(resourcesDir, "llm-apikey-lb-macos-arm64"));
  await fs.copyFile(binX64, path.join(resourcesDir, "llm-apikey-lb-macos-x64"));
  await fs.chmod(path.join(resourcesDir, "llm-apikey-lb-macos-arm64"), 0o755);
  await fs.chmod(path.join(resourcesDir, "llm-apikey-lb-macos-x64"), 0o755);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RES_DIR="$APP_DIR/Resources"
ARCH="$(uname -m)"
BIN="$RES_DIR/llm-apikey-lb-macos-arm64"
if [[ "$ARCH" == "x86_64" ]]; then
  BIN="$RES_DIR/llm-apikey-lb-macos-x64"
fi
nohup "$BIN" >/dev/null 2>&1 &
exit 0
`;
  const execPath = path.join(macosDir, "llm-apikey-lb");
  await fs.writeFile(execPath, launcher, "utf8");
  await fs.chmod(execPath, 0o755);

  if (process.platform === "darwin") {
    const zipPath = path.join(distDir, "llm-apikey-lb-macos.app.zip");
    await rmIfExists(zipPath);
    const res = spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], {
      stdio: "inherit"
    });
    if (res.status !== 0) fail("failed to zip .app via ditto");
  }

  process.stdout.write(`created ${appPath}\n`);
}

main().catch((e) => fail(e && e.stack ? e.stack : e));
