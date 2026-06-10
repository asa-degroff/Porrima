import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("API auth boundary", () => {
  it("keeps corpus routes behind the global /api auth middleware", () => {
    const indexSource = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");

    const authRoutesMount = indexSource.indexOf('app.use("/api/auth", authRouter)');
    const authBoundaryMount = indexSource.indexOf('app.use("/api", requireAuth)');
    const corpusMount = indexSource.indexOf('app.use("/api/corpus", corpusRouter)');

    expect(authRoutesMount).toBeGreaterThanOrEqual(0);
    expect(authBoundaryMount).toBeGreaterThan(authRoutesMount);
    expect(corpusMount).toBeGreaterThan(authBoundaryMount);
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
