import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";

const REPOSITORY = "peterxiemin/t3code";
const API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const INTERVAL = 4 * 60 * 60 * 1000;
const MAX_ARCHIVE = 2_000_000_000;
const BUNDLE_ID = "com.t3tools.t3code";

function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)(?:\.personal\.(\d+))?$/.exec(value);
  return m ? m.slice(1).map((part) => Number(part ?? 0)) : null;
}
export function newer(a, b) {
  const left = parseVersion(a),
    right = parseVersion(b);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}
export function selectRelease(releases, current) {
  if (!Array.isArray(releases) || !parseVersion(current)) return null;
  const candidates = [];
  for (const release of releases) {
    if (!release || release.draft || !release.prerelease || typeof release.tag_name !== "string")
      continue;
    const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
    if (!newer(version, current) || !Array.isArray(release.assets)) continue;
    const name = `T3-Code-${version}-arm64.zip`;
    const expected = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
    const assets = release.assets.filter(
      (a) =>
        a.name === name &&
        a.browser_download_url === expected &&
        typeof a.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(a.digest) &&
        Number.isSafeInteger(a.size) &&
        a.size > 0 &&
        a.size <= MAX_ARCHIVE,
    );
    if (assets.length === 1)
      candidates.push({
        version,
        url: expected,
        sha256: assets[0].digest.slice(7),
        size: assets[0].size,
      });
  }
  return candidates.reduce(
    (best, candidate) => (!best || newer(candidate.version, best.version) ? candidate : best),
    null,
  );
}
export async function downloadVerified(asset, destination, fetcher = fetch) {
  const response = await fetcher(asset.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  let size = 0;
  const hash = NodeCrypto.createHash("sha256");
  const check = new NodeStream.Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > asset.size || size > MAX_ARCHIVE)
        return callback(new Error("Archive exceeds expected size"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    check,
    NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (size !== asset.size || hash.digest("hex") !== asset.sha256)
    throw new Error("Archive checksum or size mismatch");
}
function command(file, args, options = {}) {
  const result = NodeChildProcess.spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`${file} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function plist(app, key) {
  return command("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    NodePath.join(app, "Contents", "Info.plist"),
  ]);
}
export function validateEntries(list) {
  const entries = list.split("\n").filter(Boolean);
  if (!entries.length) throw new Error("Empty update archive");
  let root;
  for (const item of entries) {
    if (item.startsWith("/") || item.split("/").includes("..") || item.includes("\\"))
      throw new Error("Unsafe archive path");
    const name = item.split("/")[0];
    if (!name.endsWith(".app") || (root && root !== name))
      throw new Error("Archive must contain exactly one application");
    root = name;
  }
  return root;
}
function parentAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function otherInstances(executable, parentPid) {
  const lines = command("/bin/ps", ["-axww", "-o", "pid=,command="]).split("\n");
  return lines.some((line) => {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    return (
      m &&
      Number(m[1]) !== process.pid &&
      Number(m[1]) !== parentPid &&
      (m[2] === executable || m[2].startsWith(`${executable} `))
    );
  });
}
async function log(message) {
  const dir = NodePath.join(NodeOS.homedir(), "Library", "Logs", "T3 Code");
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.appendFile(
    NodePath.join(dir, "personal-mac-update.log"),
    `${new Date().toISOString()} ${message}\n`,
  );
}
async function tellFailure() {
  NodeChildProcess.spawnSync(
    "/usr/bin/osascript",
    [
      "-e",
      'display notification "个人版自动更新未完成；当前版本仍可使用。详情见 T3 Code 日志。" with title "T3 Code 更新"',
    ],
    { stdio: "ignore" },
  );
}
export async function installArchive({
  archive,
  appPath,
  executable,
  parentPid,
  expectedVersion,
  newVersion,
}) {
  const parent = NodePath.dirname(appPath);
  if (
    !NodePath.isAbsolute(appPath) ||
    !appPath.endsWith(".app") ||
    appPath.includes("/AppTranslocation/") ||
    appPath.startsWith("/Volumes/")
  )
    throw new Error("Move T3 Code to a writable applications folder before updating");
  const oldStat = await NodeFSP.lstat(appPath);
  if (!oldStat.isDirectory() || oldStat.isSymbolicLink())
    throw new Error("Application is not a regular directory");
  if (
    plist(appPath, "CFBundleIdentifier") !== BUNDLE_ID ||
    plist(appPath, "CFBundleShortVersionString") !== expectedVersion
  )
    throw new Error("Installed application changed while update was downloading");
  const root = validateEntries(command("/usr/bin/unzip", ["-Z", "-1", archive]));
  const staging = await NodeFSP.mkdtemp(NodePath.join(parent, ".t3-personal-update-"));
  const backup = NodePath.join(staging, "old.app");
  const next = NodePath.join(staging, root);
  let oldMoved = false;
  try {
    command("/usr/bin/ditto", ["-x", "-k", archive, staging]);
    if (
      plist(next, "CFBundleIdentifier") !== BUNDLE_ID ||
      plist(next, "CFBundleShortVersionString") !== newVersion
    )
      throw new Error("Downloaded application identity or version does not match");
    for (let i = 0; i < 60 && otherInstances(executable, parentPid); i++) await sleep(1000);
    if (parentAlive(parentPid) || otherInstances(executable, parentPid))
      throw new Error("Another T3 process is still using this application");
    await NodeFSP.rename(appPath, backup);
    oldMoved = true;
    try {
      await NodeFSP.rename(next, appPath);
    } catch (error) {
      await NodeFSP.rename(backup, appPath);
      oldMoved = false;
      throw error;
    }
    await NodeFSP.rm(backup, { recursive: true, force: true });
    oldMoved = false;
  } finally {
    if (!oldMoved) await NodeFSP.rm(staging, { recursive: true, force: true });
    else await log(`Recovery copy retained at ${backup}`).catch(() => {});
  }
}
async function run(pid, appPath, executable, version) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !parseVersion(version))
    throw new Error("Invalid updater arguments");
  let staged = null;
  let lastCheck = 0;
  try {
    while (parentAlive(pid)) {
      if (Date.now() - lastCheck >= INTERVAL) {
        lastCheck = Date.now();
        try {
          const response = await fetch(API, {
            headers: {
              "User-Agent": "T3-Code-Personal-Updater",
              Accept: "application/vnd.github+json",
            },
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw new Error(`Release lookup failed: HTTP ${response.status}`);
          const release = selectRelease(await response.json(), staged?.version ?? version);
          if (release) {
            const dir = await NodeFSP.mkdtemp(
              NodePath.join(NodeOS.tmpdir(), "t3-personal-mac-download-"),
            );
            try {
              const archive = NodePath.join(dir, "update.zip");
              await downloadVerified(release, archive);
              const previous = staged;
              staged = { dir, archive, version: release.version };
              if (previous) await NodeFSP.rm(previous.dir, { recursive: true, force: true });
              await log(`Downloaded and verified ${release.version}`);
            } catch (error) {
              await NodeFSP.rm(dir, { recursive: true, force: true });
              throw error;
            }
          }
        } catch (error) {
          await log(`Update check failed: ${error.message}`).catch(() => {});
        }
      }
      if (parentAlive(pid)) await sleep(5000);
    }
    if (staged) {
      try {
        await installArchive({
          archive: staged.archive,
          appPath,
          executable,
          parentPid: pid,
          expectedVersion: version,
          newVersion: staged.version,
        });
        await log(`Installed ${staged.version}`);
      } catch (error) {
        await log(`Installation failed: ${error.message}`).catch(() => {});
        await tellFailure();
      }
    }
  } finally {
    if (staged) await NodeFSP.rm(staged.dir, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [pid, appPath, executable, version] = process.argv.slice(2);
  run(Number(pid), appPath, executable, version).catch((error) =>
    log(`Updater failed: ${error.message}`).catch(() => {}),
  );
}
