#!/usr/bin/env node
// Build prebuilt Zig binaries for every supported target, attach them to a
// GitHub release at the current `package.json` version, and publish the
// npm package (including the js/ sidecar). Inspired by
// ../smithers/scripts/publish.mjs.
//
// Usage:
//   npm run release                   # full release: build all + tag + GH release + npm publish
//   npm run release -- --dry-run      # everything up to (but not including) `gh release create` and `npm publish`
//   npm run release -- --skip-tests   # skip `zig build test`
//   npm run release -- --skip-git     # skip clean-tree check
//   npm run release -- --otp=123456   # npm 2fa code
//   npm run release -- --local-only   # build prebuilts but don't publish anywhere (smoke test)
//
// Required env for full publish:
//   - GH_TOKEN (or you must be logged in via `gh auth login`)
//   - npm auth (NPM_TOKEN in CI, or `npm login` locally)
//
// Required tooling:
//   - zig 0.15.2 on $PATH (cross-compiles natively)
//   - gh CLI
//   - npm
//
// Targets:
//   - aarch64-macos     -> prebuilt/darwin-arm64/claude-p
//   - x86_64-macos      -> prebuilt/darwin-x64/claude-p
//   - x86_64-linux-musl -> prebuilt/linux-x64/claude-p
//   - aarch64-linux-musl-> prebuilt/linux-arm64/claude-p
//
// Each is gzipped to release-assets/claude-p-<platform>-<arch>.gz and
// uploaded as a GitHub release asset. The npm `postinstall` hook in
// scripts/install.js downloads the right one at install time.

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY_RUN = !!args["dry-run"];
const SKIP_TESTS = !!args["skip-tests"];
const SKIP_GIT = !!args["skip-git"];
const LOCAL_ONLY = !!args["local-only"];
const OTP = typeof args.otp === "string" ? args.otp : null;

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const TARGETS = [
  { zig: "aarch64-macos",      platform: "darwin",  arch: "arm64" },
  { zig: "x86_64-macos",       platform: "darwin",  arch: "x64"   },
  { zig: "x86_64-linux-musl",  platform: "linux",   arch: "x64"   },
  { zig: "aarch64-linux-musl", platform: "linux",   arch: "arm64" },
];

function log(step, msg) {
  console.log(`\n▸ [${step}] ${msg}`);
}

function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

function capture(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

log("version", `releasing v${version} (from package.json)`);

if (!SKIP_GIT) {
  log("git", "checking clean working tree");
  const out = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  if (out.stdout.trim()) {
    throw new Error(
      `working tree is dirty — commit or stash first (or pass --skip-git):\n${out.stdout}`,
    );
  }
}

if (!SKIP_TESTS) {
  log("test", "zig build test + js sidecar tests");
  run("zig build test");
  run("node --test js/test/*.test.js");
} else {
  log("test", "skipped (--skip-tests)");
}

// ---------------------------------------------------------------------------
// Build prebuilts
// ---------------------------------------------------------------------------

rmSync(join(root, "prebuilt"), { recursive: true, force: true });
rmSync(join(root, "release-assets"), { recursive: true, force: true });
mkdirSync(join(root, "release-assets"), { recursive: true });

for (const t of TARGETS) {
  log("build", `${t.zig} -> prebuilt/${t.platform}-${t.arch}/claude-p`);
  const cacheDir = join(root, ".zig-cache", "release", t.zig);
  run(
    `zig build -Doptimize=ReleaseSafe -Dtarget=${t.zig} --cache-dir ${cacheDir} -p prebuilt-stage-${t.zig}`,
  );

  // zig install drops the binary into <prefix>/bin/claude-p
  const built = join(root, `prebuilt-stage-${t.zig}`, "bin", "claude-p");
  if (!existsSync(built)) {
    throw new Error(`expected built binary at ${built}, not found`);
  }
  const destDir = join(root, "prebuilt", `${t.platform}-${t.arch}`);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "claude-p");
  writeFileSync(dest, readFileSync(built), { mode: 0o755 });

  // Gzip into release-assets/.
  const gz = gzipSync(readFileSync(built), { level: 9 });
  const asset = join(
    root,
    "release-assets",
    `claude-p-${t.platform}-${t.arch}.gz`,
  );
  writeFileSync(asset, gz);
  console.log(
    `  built ${(readFileSync(built).length / 1024).toFixed(1)} KiB raw, ` +
      `${(gz.length / 1024).toFixed(1)} KiB gzipped`,
  );

  // Clean the staging install.
  rmSync(join(root, `prebuilt-stage-${t.zig}`), { recursive: true, force: true });
}

// The interactive mode needs the node sidecar shipped next to the shim.
for (const f of ["js/host.js", "js/rpc.js", "js/package.json"]) {
  if (!existsSync(join(root, f))) throw new Error(`missing ${f} — the npm package would ship without the sidecar`);
}

log("smoke", "exercising the native prebuilt's --version");
const nativePlatform = process.platform;
const nativeArch = process.arch;
const native = TARGETS.find(
  (t) => t.platform === nativePlatform && t.arch === nativeArch,
);
if (native) {
  const bin = join(root, "prebuilt", `${native.platform}-${native.arch}`, "claude-p");
  if (existsSync(bin)) {
    run(`${bin} --version`);
  }
} else {
  console.log(`  (skipped — no native target match for ${nativePlatform}-${nativeArch})`);
}

if (LOCAL_ONLY) {
  console.log("\n✓ --local-only: built prebuilts in ./prebuilt/, gzipped in ./release-assets/. Stopping.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

log("git", `tagging v${version} (if not already tagged)`);
const tags = capture("git tag --list");
if (!tags.split("\n").includes(`v${version}`)) {
  if (DRY_RUN) {
    console.log(`  DRY RUN — would run: git tag v${version}`);
  } else {
    run(`git tag -a v${version} -m "claude-p v${version}"`);
  }
} else {
  console.log(`  v${version} already tagged locally`);
}

// Push tag if not already at remote (idempotent — surviveable when CI is
// triggered by a tag push, where the tag is already there).
const remoteTag = capture(`git ls-remote --tags origin v${version} || true`);
if (remoteTag.trim()) {
  console.log(`  v${version} already pushed to origin`);
} else if (DRY_RUN) {
  console.log("  DRY RUN — would push tag with: git push origin v" + version);
} else {
  run(`git push origin v${version}`);
}

// ---------------------------------------------------------------------------
// GitHub release
// ---------------------------------------------------------------------------

log("github", "creating release + uploading assets");
const assets = TARGETS.map((t) =>
  join(root, "release-assets", `claude-p-${t.platform}-${t.arch}.gz`),
);
const assetArgs = assets.map((a) => `"${a}"`).join(" ");

if (DRY_RUN) {
  console.log(
    `  DRY RUN — would run: gh release create v${version} --title "claude-p v${version}" --notes "automated release" ${assetArgs}`,
  );
} else {
  // If the release already exists, upload assets to it; otherwise create.
  const releaseExists =
    spawnSync("gh", ["release", "view", `v${version}`], {
      cwd: root,
      stdio: "ignore",
    }).status === 0;
  if (releaseExists) {
    run(`gh release upload v${version} ${assetArgs} --clobber`);
  } else {
    run(
      `gh release create v${version} --title "claude-p v${version}" --notes "Automated release. See REPORT.md and CHANGELOG (if present)." ${assetArgs}`,
    );
  }
}

// ---------------------------------------------------------------------------
// npm publish
// ---------------------------------------------------------------------------

log("npm", "checking auth");
if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
  console.log("  CI: trusting NODE_AUTH_TOKEN / NPM_TOKEN; skipping whoami");
} else {
  const who = spawnSync("npm", ["whoami"], { cwd: root, encoding: "utf8" });
  if (who.status === 0) {
    console.log(`  logged in as ${who.stdout.trim()}`);
  } else if (!DRY_RUN) {
    console.log("  not logged in — running `npm login` (interactive)");
    run("npm login");
  }
}

const otpFlag = OTP ? ` --otp=${OTP}` : "";
if (DRY_RUN) {
  console.log(
    `  DRY RUN — would run: npm publish --access public${otpFlag}`,
  );
} else {
  log("npm", "publish");
  run(`npm publish --access public${otpFlag}`);
}

console.log(`\n✓ v${version} ${DRY_RUN ? "(dry run) " : ""}done`);
