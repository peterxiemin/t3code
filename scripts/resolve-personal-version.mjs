import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const tagPattern = /^personal-upstream\/v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

export function resolvePersonalVersion(tags, runNumber) {
  if (!/^[1-9]\d*$/.test(runNumber)) throw new Error("Invalid personal build number");
  const candidates = tags
    .map((tag) => ({ tag, match: tagPattern.exec(tag) }))
    .filter((v) => v.match);
  candidates.sort((a, b) => {
    for (let i = 1; i <= 5; i++) {
      const difference = Number(b.match[i]) - Number(a.match[i]);
      if (difference) return difference;
    }
    return 0;
  });
  if (!candidates.length) throw new Error("No official nightly tag is an ancestor of this build");
  const baseline = candidates[0].tag.slice("personal-upstream/v".length);
  return { baseline, version: `${baseline}.personal.${runNumber}` };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const tags = NodeChildProcess.execFileSync(
    "git",
    ["tag", "--merged", "HEAD", "--list", "personal-upstream/v*-nightly.*"],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n");
  const { baseline, version } = resolvePersonalVersion(tags, process.argv[2] ?? "");
  process.stdout.write(`baseline=${baseline}\nversion=${version}\n`);
}
