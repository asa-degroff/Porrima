import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("API auth boundary", () => {
  it("keeps image-serving routes behind the global /api auth middleware", () => {
    const indexSource = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");

    const authRoutesMount = indexSource.indexOf('app.use("/api/auth", authRouter)');
    const authBoundaryMount = indexSource.indexOf('app.use("/api", requireAuth)');

    expect(authRoutesMount).toBeGreaterThanOrEqual(0);
    expect(authBoundaryMount).toBeGreaterThan(authRoutesMount);

    // Chat attachments, tool-result figures, and on-demand scratch images all
    // serve user files, so each has to sit behind the boundary.
    for (const mount of [
      'app.use("/api/user-images", userImagesRouter)',
      'app.use("/api/tool-result-images", toolResultImagesRouter)',
      'app.use("/api/local-images", localImagesRouter)',
    ]) {
      const index = indexSource.indexOf(mount);
      expect(index, `${mount} is not mounted`).toBeGreaterThanOrEqual(0);
      expect(index, `${mount} is mounted before requireAuth`).toBeGreaterThan(authBoundaryMount);
    }
  });

  it("does not mount non-auth API routers before requireAuth", () => {
    const indexSource = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");
    const authBoundaryMount = indexSource.indexOf('app.use("/api", requireAuth)');
    expect(authBoundaryMount).toBeGreaterThanOrEqual(0);

    const beforeAuth = indexSource.slice(0, authBoundaryMount);
    const apiMountsBeforeAuth = Array.from(beforeAuth.matchAll(/app\.use\("\/api\/([^"]+)"/g))
      .map((match) => match[1]);

    expect(apiMountsBeforeAuth).toEqual(["auth"]);
  });
});
