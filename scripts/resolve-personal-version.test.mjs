import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { resolvePersonalVersion } from "./resolve-personal-version.mjs";

NodeTest.test(
  "preserves the newest official nightly and orders personal builds numerically",
  () => {
    const tags = [
      "personal-upstream/v0.1.9-nightly.20261114.9999",
      "personal-upstream/v0.1.10-nightly.20261114.9",
      "personal-upstream/v0.1.10-nightly.20261114.10",
      "personal-upstream/v0.1.99-preview.20261114.999",
    ];
    NodeAssert.deepEqual(resolvePersonalVersion(tags, "8"), {
      baseline: "0.1.10-nightly.20261114.10",
      version: "0.1.10-nightly.20261114.10.personal.8",
    });
    NodeAssert.throws(() => resolvePersonalVersion([], "8"), /No official nightly/);
    NodeAssert.throws(() => resolvePersonalVersion(tags, "0"), /Invalid personal/);
  },
);

NodeTest.test("ignores an official release that is not in the build's ancestry", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-personal-version-"));
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    git("init", "-q");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    );
    git("tag", "personal-upstream/v0.1.10-nightly.20261114.4669");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "newer",
    );
    git("tag", "personal-upstream/v0.1.10-nightly.20261115.4700");
    git("checkout", "-q", "--detach", "HEAD~1");
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./resolve-personal-version.mjs", import.meta.url)), "8"],
      { cwd: dir, encoding: "utf8" },
    );
    NodeAssert.match(output, /version=0\.1\.10-nightly\.20261114\.4669\.personal\.8/);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
