import { describe, expect, it } from "vitest";
import { compareSemverLike } from "./app-version.js";

describe("compareSemverLike", () => {
  it("compares v-prefixed semver release tags", () => {
    expect(compareSemverLike("0.1.0", "v0.1.1")).toBe(-1);
    expect(compareSemverLike("0.2.0", "v0.1.9")).toBe(1);
    expect(compareSemverLike("v1.0.0", "1.0.0")).toBe(0);
  });

  it("returns null for non-semver builds", () => {
    expect(compareSemverLike("main", "v0.1.0")).toBeNull();
    expect(compareSemverLike("0.1", "v0.1.0")).toBeNull();
  });
});
