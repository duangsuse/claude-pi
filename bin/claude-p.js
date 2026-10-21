#!/usr/bin/env node
// Thin shim that execs the platform-specific prebuilt `claude-p` binary
// downloaded by scripts/install.js into ../prebuilt/.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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

function main() {
  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    console.error(
      `claude-p: prebuilt binary not found at ${bin}\n` +
        `Re-run \`npm install claude-p\` or build from source with \`zig build\`.`,
    );
    process.exit(2);
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

main();
