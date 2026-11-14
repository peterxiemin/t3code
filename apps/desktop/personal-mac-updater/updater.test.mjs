import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  selectRelease,
  newer,
  downloadVerified,
  validateEntries,
  installArchive,
} from "./updater.mjs";

const asset = (version, content) => ({
  name: `T3-Code-${version}-arm64.zip`,
  browser_download_url: `https://github.com/peterxiemin/t3code/releases/download/v${version}/T3-Code-${version}-arm64.zip`,
  digest: `sha256:${NodeCrypto.createHash("sha256").update(content).digest("hex")}`,
  size: content.length,
});
const release = (version, content) => ({
  tag_name: `v${version}`,
  prerelease: true,
  draft: false,
  assets: [asset(version, content)],
});

NodeTest.test("selects the newest valid personal nightly release and rejects other URLs", () => {
  const old = "0.1.9-nightly.20261114.6",
    next = "0.1.9-nightly.20261114.7",
    latest = "0.1.10-nightly.20261115.1";
  const bad = release(latest, "hello");
  bad.assets[0].browser_download_url = "https://example.org/fake.zip";
  NodeAssert.equal(selectRelease([bad, release(old, "a"), release(next, "b")], old).version, next);
  NodeAssert.equal(selectRelease([bad], old), null);
  NodeAssert.equal(newer(latest, next), true);
  NodeAssert.equal(newer("0.1.9-preview.20261114.5", old), false);
});

NodeTest.test("verifies downloaded bytes and rejects a mismatched digest", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-update-test-"));
  try {
    const content = "verified data";
    const item = asset("0.1.9-nightly.20261114.7", content);
    const input = { url: item.browser_download_url, sha256: item.digest.slice(7), size: item.size };
    const fetcher = async () => new Response(content);
    await downloadVerified(input, NodePath.join(dir, "good.zip"), fetcher);
    NodeAssert.equal(await NodeFSP.readFile(NodePath.join(dir, "good.zip"), "utf8"), content);
    await NodeAssert.rejects(
      downloadVerified(
        { ...input, sha256: "0".repeat(64) },
        NodePath.join(dir, "bad.zip"),
        fetcher,
      ),
      /checksum/,
    );
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

NodeTest.test("refuses paths outside a single app bundle", () => {
  NodeAssert.equal(validateEntries("T3.app/\nT3.app/Contents/Info.plist\n"), "T3.app");
  for (const value of ["../T3.app/x", "/T3.app/x", "T3.app/../../x", "T3.app/x\nOther.app/x"])
    NodeAssert.throws(() => validateEntries(value));
});

const plist = (version) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.t3tools.t3code</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
async function appAt(dir, version) {
  await NodeFSP.mkdir(NodePath.join(dir, "Contents"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dir, "Contents", "Info.plist"), plist(version));
}

NodeTest.test(
  "macOS replaces the app only after validating the archive and retains it on failure",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This integration test requires macOS system tools.
  { skip: NodeOS.platform() !== "darwin" },
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-update-install-test-"));
    const old = "0.1.9-nightly.20261114.6",
      next = "0.1.9-nightly.20261114.7";
    try {
      const app = NodePath.join(root, "T3 Code.app");
      const source = NodePath.join(root, "source", "T3 Code.app");
      const zip = NodePath.join(root, "update.zip");
      await appAt(app, old);
      await appAt(source, next);
      const result = NodeChildProcess.spawnSync(
        "/usr/bin/ditto",
        ["-c", "-k", "--keepParent", source, zip],
        {
          encoding: "utf8",
        },
      );
      NodeAssert.equal(result.status, 0, result.stderr);
      const input = {
        archive: zip,
        appPath: app,
        executable: NodePath.join(app, "Contents/MacOS/T3 Code"),
        parentPid: 2147483647,
        expectedVersion: old,
        newVersion: next,
      };
      await NodeAssert.rejects(
        installArchive({ ...input, newVersion: "0.1.9-nightly.20261114.8" }),
        /identity or version/,
      );
      NodeAssert.match(
        await NodeFSP.readFile(NodePath.join(app, "Contents/Info.plist"), "utf8"),
        new RegExp(old.replaceAll(".", "\\.")),
      );
      await installArchive(input);
      NodeAssert.match(
        await NodeFSP.readFile(NodePath.join(app, "Contents/Info.plist"), "utf8"),
        new RegExp(next.replaceAll(".", "\\.")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "macOS installs the actual packaged archive after version and identity checks",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This integration test requires macOS system tools.
  { skip: NodeOS.platform() !== "darwin" || !process.env.T3CODE_MAC_UPDATE_TEST_ARCHIVE },
  async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-update-real-package-test-"),
    );
    const old = "0.0.1-nightly.20260101.1";
    try {
      const app = NodePath.join(root, "T3 Code.app");
      await appAt(app, old);
      await installArchive({
        archive: process.env.T3CODE_MAC_UPDATE_TEST_ARCHIVE,
        appPath: app,
        executable: NodePath.join(app, "Contents/MacOS/T3 Code"),
        parentPid: 2147483647,
        expectedVersion: old,
        newVersion: process.env.T3CODE_MAC_UPDATE_TEST_VERSION,
      });
      const result = NodeChildProcess.spawnSync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleShortVersionString", NodePath.join(app, "Contents/Info.plist")],
        { encoding: "utf8" },
      );
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.equal(result.stdout.trim(), process.env.T3CODE_MAC_UPDATE_TEST_VERSION);
      await NodeFSP.access(NodePath.join(app, "Contents/Resources/personal-mac-updater.mjs"));
      const executable = NodeChildProcess.spawnSync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleExecutable", NodePath.join(app, "Contents/Info.plist")],
        { encoding: "utf8" },
      );
      NodeAssert.equal(executable.status, 0, executable.stderr);
      const launched = NodeChildProcess.spawnSync(
        NodePath.join(app, "Contents/MacOS", executable.stdout.trim()),
        ["--version"],
        { encoding: "utf8", timeout: 30000 },
      );
      NodeAssert.equal(launched.status, 0, launched.stderr);
      NodeAssert.equal(launched.stdout.trim(), process.env.T3CODE_MAC_UPDATE_TEST_VERSION);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
