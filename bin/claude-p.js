#!/usr/bin/env node
// Thin shim that execs the platform-specific prebuilt `claude-p` binary
// downloaded into ../prebuilt/.
//
// The download normally happens in `postinstall`, but npm 11.19+ gates
// dependency install scripts behind its allow-scripts allowlist and `npx`
// skips them silently, so the shim also ensures the binary itself. That is
// what makes `npx cld-pi` work on a fresh machine.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ensureInstalled, unsupportedMessage } = require("../scripts/install.js");

function platformDir() {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function binaryPath() {
  const dir = path.join(__dirname, "..", "prebuilt", platformDir());
  const name = process.platform === "win32" ? "claude-p.exe" : "claude-p";
  return path.join(dir, name);
}

async function main() {
  if (process.platform === "win32") {
    console.error(unsupportedMessage("win32"));
    process.exit(2);
  }
  const bin = binaryPath();
  if (!fs.existsSync(bin) && !(await ensureInstalled())) {
    console.error(
      `claude-p: prebuilt binary not found at ${bin}\n` +
        `The download failed (see above). If you are behind a proxy, check ` +
        `HTTPS_PROXY/NO_PROXY, or build from source with \`zig build\`.`,
    );
    process.exit(2);
  }
  // npm/tar can lose the executable bit; make sure spawnSync can exec it.
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Best effort; spawnSync below reports the real error.
  }
  // Tell the binary where the node sidecar (js/host.js) lives.
  const env = { ...process.env, CLAUDE_P_JS: path.join(__dirname, "..", "js") };
  const result = spawnSync(bin, process.argv.slice(2), {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    console.error("claude-p:", result.error.message);
    process.exit(2);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 0);
}

main().catch((err) => {
  console.error("claude-p:", err.stack || err.message);
  process.exit(2);
});
