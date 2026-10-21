#!/usr/bin/env node
// Postinstall: download the prebuilt `claude-p` binary for the current
// platform/arch from a GitHub release and drop it into prebuilt/<plat>-<arch>/.
//
// Strategy:
//   1. If a binary already exists at the expected path (e.g. installed from
//      cache or a previous run), do nothing.
//   2. Otherwise, try `prebuilt/<plat>-<arch>/claude-p` shipped in the
//      package (publishers can pre-bundle for the most common targets).
//   3. Failing that, download from
//      https://github.com/<repository>/releases/download/v<version>/claude-p-<plat>-<arch>.gz
//      (repo taken from package.json), gunzip, and chmod +x.
//
// If `CLAUDE_P_SKIP_DOWNLOAD=1` is set, exit 0 without doing anything (useful
// for monorepo bootstraps where the binary is provided out-of-band).

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const pkg = require("../package.json");

function log(msg) {
  process.stderr.write(`claude-p (install): ${msg}\n`);
}

function platformDir() {
  return `${process.platform}-${process.arch}`;
}

function exeName() {
  return process.platform === "win32" ? "claude-p.exe" : "claude-p";
}

function targetPath() {
  return path.join(__dirname, "..", "prebuilt", platformDir(), exeName());
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function alreadyInstalled() {
  try {
    const stat = fs.statSync(targetPath());
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function isSupported() {
  const okPlatform = ["darwin", "linux"].includes(process.platform);
  const okArch = ["x64", "arm64"].includes(process.arch);
  return okPlatform && okArch;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          // Follow redirect (GitHub release assets do this).
          resolve(get(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// GitHub repo the release assets live on, from package.json `repository`.
function releaseRepo() {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const m = url && url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

async function download() {
  const repo = releaseRepo();
  if (!repo) throw new Error("package.json has no GitHub `repository`; no release to download from");
  const url = `https://github.com/${repo}/releases/download/v${pkg.version}/claude-p-${platformDir()}.gz`;
  log(`downloading ${url}`);
  const gz = await get(url);
  const bin = zlib.gunzipSync(gz);
  const dest = targetPath();
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, bin, { mode: 0o755 });
  log(`installed ${dest} (${bin.length} bytes)`);
}

async function main() {
  if (process.env.CLAUDE_P_SKIP_DOWNLOAD === "1") {
    log("CLAUDE_P_SKIP_DOWNLOAD set; skipping");
    return;
  }
  if (!isSupported()) {
    log(`platform ${platformDir()} not supported; skipping`);
    return;
  }
  if (alreadyInstalled()) {
    log(`already installed at ${targetPath()}`);
    return;
  }
  try {
    await download();
  } catch (err) {
    log(`download failed: ${err.message}`);
    log("you can build from source with: zig build -Doptimize=ReleaseSafe");
    // Don't fail the install — leave the binary missing; the shim will
    // print a clear error if the user runs `claude-p` later.
  }
}

main().catch((err) => {
  log(`unexpected error: ${err.stack || err.message}`);
  // Same as above: don't break the npm install.
});
