import { expect, it } from "vite-plus/test";
import { isNightlyDesktopVersion } from "./updateChannels.ts";

it("recognizes official and personal nightly versions", () => {
  expect(isNightlyDesktopVersion("0.1.10-nightly.20261114.4669")).toBe(true);
  expect(isNightlyDesktopVersion("0.1.10-nightly.20261114.4669.personal.8")).toBe(true);
  expect(isNightlyDesktopVersion("0.1.10")).toBe(false);
});
