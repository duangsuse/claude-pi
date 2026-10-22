#!/usr/bin/env node
// Download the prebuilt `claude-p` binary for the current platform/arch from
// a GitHub release and drop it into prebuilt/<plat>-<arch>/.
//
// Used both as the npm `postinstall` script and from `bin/claude-p.js`, so
// `npx cld-pi` still works when npm skips install scripts (npm 11.19+ gates
// dependency scripts behind its allow-scripts allowlist and npx skips them
// silently by default).
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
// Proxy: Node's https client ignores HTTPS_PROXY, so when a proxy is
// configured (and curl is available) the download goes through curl, which
// honours the standard proxy variables. A failed direct request also falls
// back to curl.
//
// If `CLAUDE_P_SKIP_DOWNLOAD=1` is set, do nothing (useful for monorepo
// bootstraps where the binary is provided out-of-band).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const pkg = require("../package.json");

function log(msg) {
  for (const line of String(msg).split("\n")) {
    process.stderr.write(`claude-p (install): ${line}\n`);
  }
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

// Shown by both the postinstall script and the bin shim. Windows users get
// the WSL + Windows Terminal one-liners instead of a silent missing binary.
function unsupportedMessage(platform = process.platform) {
  if (platform === "win32") {
    return [
      "native Windows is not supported; cld-pi runs inside WSL (Linux).",
      "",
      "  wsl --install                                     # WSL + Ubuntu, one time",
      "  winget install --id Microsoft.WindowsTerminal -e  # Windows Terminal",
      "",
      "Then open the Ubuntu terminal and run: npx cld-pi",
    ].join("\n");
  }
  return `platform ${platformDir()} is not supported (need darwin/linux x64/arm64)`;
}

// npm strips the executable bit in a few situations (tar extraction, some
// filesystems/umasks), so set it explicitly before the shim spawns the binary.
function ensureExecutable(p) {
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    // Best effort; the spawn below will report EACCES if it really matters.
  }
}

function proxyConfigured() {
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy,
  );
}

let curlChecked = null;
function hasCurl() {
  if (curlChecked === null) {
    const r = spawnSync("curl", ["--version"], { stdio: "ignore" });
    curlChecked = !r.error && r.status === 0;
  }
  return curlChecked;
}

function getHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30_000 }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // Follow redirect (GitHub release assets do this).
        res.resume();
        resolve(getHttps(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

function getCurl(url) {
  const tmp = path.join(os.tmpdir(), `claude-p-${process.pid}-${Date.now()}.gz`);
  try {
    const r = spawnSync(
      "curl",
      [
        "-fsSL",
        "--retry",
        "3",
        "--connect-timeout",
        "20",
        "--max-time",
        "300",
        "-o",
        tmp,
        url,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`curl exited ${r.status} for ${url}`);
    return fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function get(url) {
  if (proxyConfigured() && hasCurl()) return getCurl(url);
  try {
    return await getHttps(url);
  } catch (err) {
    if (hasCurl()) {
      log(`direct download failed (${err.message}); retrying with curl`);
      return getCurl(url);
    }
    throw err;
  }
}

// GitHub repo the release assets live on, from package.json `repository`.
function releaseRepo() {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const m = url && url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

async function download(say) {
  const repo = releaseRepo();
  if (!repo) throw new Error("package.json has no GitHub `repository`; no release to download from");
  const url = `https://github.com/${repo}/releases/download/v${pkg.version}/claude-p-${platformDir()}.gz`;
  say(`downloading ${url}`);
  const gz = await get(url);
  const bin = zlib.gunzipSync(gz);
  const dest = targetPath();
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, bin, { mode: 0o755 });
  ensureExecutable(dest);
  say(`installed ${dest} (${bin.length} bytes)`);
}

// Returns true when the binary is present afterwards. Never throws.
async function ensureInstalled({ quiet = false } = {}) {
  const say = quiet ? () => {} : log;
  if (process.env.CLAUDE_P_SKIP_DOWNLOAD === "1") {
    say("CLAUDE_P_SKIP_DOWNLOAD set; skipping");
    return alreadyInstalled();
  }
  if (!isSupported()) {
    say(unsupportedMessage());
    return false;
  }
  if (alreadyInstalled()) {
    ensureExecutable(targetPath());
    say(`already installed at ${targetPath()}`);
    return true;
  }
  try {
    await download(say);
    return true;
  } catch (err) {
    say(`download failed: ${err.message}`);
    say("you can build from source with: zig build -Doptimize=ReleaseSafe");
    return false;
  }
}

module.exports = {
  ensureInstalled,
  unsupportedMessage,
  targetPath,
  platformDir,
  isSupported,
};

if (require.main === module) {
  ensureInstalled().catch((err) => {
    log(`unexpected error: ${err.stack || err.message}`);
    // Don't break the npm install; the shim reports the missing binary.
  });
}
