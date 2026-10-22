// The install helper is required by bin/claude-p.js on every run, so it must
// be importable without downloading anything (the postinstall entry point is
// guarded by `require.main === module`).
import { test } from "node:test";
import assert from "node:assert/strict";
import install from "../../scripts/install.js";

const { ensureInstalled, targetPath, platformDir } = install;

test("install.js imports without side effects and exposes the lazy installer", () => {
  assert.equal(typeof ensureInstalled, "function");
  assert.equal(typeof targetPath, "function");
  assert.equal(typeof platformDir, "function");
});

test("platformDir and targetPath point at prebuilt/<platform>-<arch>/", () => {
  const dir = `${process.platform}-${process.arch}`;
  assert.equal(platformDir(), dir);
  assert.match(targetPath(), new RegExp(`prebuilt[\\\\/]${dir}[\\\\/]claude-p(\\.exe)?$`));
});
