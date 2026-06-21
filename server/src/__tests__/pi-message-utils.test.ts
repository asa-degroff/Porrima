import { describe, expect, it } from "vitest";
import { sanitizeProviderText } from "../services/pi-message-utils.js";

describe("sanitizeProviderText", () => {
  it("removes embedded NUL and unsafe control characters before provider serialization", () => {
    const text = "shader error\n\u0000\nstack\tline\r\nbad\u0007char";

    expect(sanitizeProviderText(text)).toBe("shader error\n\nstack\tline\r\nbadchar");
  });

  it("removes unpaired surrogates while preserving valid pairs", () => {
    expect(sanitizeProviderText("ok \uD83D\uDE00 bad \uD800")).toBe("ok \uD83D\uDE00 bad ");
  });
});
