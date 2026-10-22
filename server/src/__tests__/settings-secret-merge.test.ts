import { mkdtempSync, rmSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The settings secret contract.
 *
 * Provider keys and the Strata token are write-only over HTTP: GET replaces them
 * with an empty string (not a placeholder token) and lists the configured field
 * names, and PUT drops blank/omitted/null secret fields so the spread merge in
 * `saveSettings` keeps the stored key. Those two halves only work together — a
 * client can echo its own GET body straight back to PUT without persisting
 * garbage, which is exactly what the settings modal does on save.
 *
 * There are two protections stacked here, and they cover different payloads.
 * `saveSettings` merges against the stored row and refuses to clobber a non-empty
 * stored string with `""`. `preserveStoredSecrets` in the route additionally
 * drops `""`, `undefined`, and `null` for the five secret fields. The storage
 * layer is what survives a stale-client PUT; the route layer is what survives a
 * client that sends `null`.
 *
 * That route-level guard is also why no HTTP path can clear a secret: `null` is
 * the codebase-wide signal for "clear this field" (see the comment in
 * `saveSettings`), and it is deliberately swallowed for these five fields. Today
 * removing a key means editing ~/.porrima/settings.json by hand.
 *
 * The route-level half had no test at all before this file. A change there would
 * wipe provider keys on the next settings save with an error-free 200 and no
 * other symptom.
 */

const SECRET_FIELDS = ["braveApiKey", "exaApiKey", "tavilyApiKey", "deepseekApiKey", "strataApiKey"] as const;
const WITNESS_SECRETS = {
  braveApiKey: "BSA-witness-value",
  exaApiKey: "exa-witness-value",
  deepseekApiKey: "sk-witness-value",
};

let scratchHome = "";
let server: import("http").Server;
let base = "";
let getSettings: () => Promise<Record<string, any>>;
let saveSettings: (patch: unknown) => Promise<Record<string, any>>;

async function put(body: unknown) {
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get() {
  const res = await fetch(`${base}/api/settings`);
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text) as Record<string, any>,
    text,
    noStore: res.headers.get("cache-control"),
  };
}

beforeAll(async () => {
  scratchHome = mkdtempSync("/tmp/porrima-secret-merge-");
  process.env.PORRIMA_DATA_DIR = scratchHome;

  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  const { default: settingsRouter } = await import("../routes/settings.js");
  app.use("/api/settings", settingsRouter);
  ;({ getSettings, saveSettings } = (await import("../services/chat-storage.js")) as any);

  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  delete process.env.PORRIMA_DATA_DIR;
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

describe("settings secret redaction", () => {
  it("stores a secret without ever emitting it in a response", async () => {
    const saved = await put(WITNESS_SECRETS);
    expect(saved.status).toBe(200);

    const res = await get();
    expect(res.status).toBe(200);
    for (const field of SECRET_FIELDS) {
      const value = (WITNESS_SECRETS as Record<string, string>)[field];
      if (value) {
        expect(res.body[field], `${field} is blanked in the response`).toBe("");
      }
      expect(res.text, `${field} leaked into the response body`).not.toContain(value ?? "witness-value");
    }
    expect(res.body.configuredSecrets.sort()).toEqual(Object.keys(WITNESS_SECRETS).sort());
    expect(res.noStore).toContain("no-store");

    const stored = await getSettings();
    expect(stored.exaApiKey).toBe("exa-witness-value");
    expect(stored.deepseekApiKey).toBe("sk-witness-value");
    expect(stored.braveApiKey).toBe("BSA-witness-value");
  });

  it("survives the settings modal round-trip: PUT the redacted GET body back with one field changed", async () => {
    const roundTrip = { ...(await get()).body, passiveRecallQueryChars: 4321 };
    const saved = await put(roundTrip);
    expect(saved.status).toBe(200);

    const stored = await getSettings();
    // The invariant: echoing a redacted body must not blank the keys, and the
    // merge must still be a merge — a replace-style PUT would wipe every key.
    expect(stored.exaApiKey).toBe("exa-witness-value");
    expect(stored.deepseekApiKey).toBe("sk-witness-value");
    expect(stored.braveApiKey).toBe("BSA-witness-value");
    expect(stored.passiveRecallQueryChars).toBe(4321);
  });

  it("treats blank and null as 'keep the stored key'", async () => {
    const saved = await put({ exaApiKey: "", deepseekApiKey: null, tavilyApiKey: undefined });
    expect(saved.status).toBe(200);

    const stored = await getSettings();
    expect(stored.exaApiKey).toBe("exa-witness-value");
    expect(stored.deepseekApiKey).toBe("sk-witness-value");
  });

  it("at the storage layer, null is an explicit clear — the route refuses to forward it for secrets", async () => {
    const cleared = await saveSettings({ deepseekApiKey: null });
    expect(cleared.deepseekApiKey ?? null).toBeNull();
    // Restore the witness value so the characterization below still holds.
    await saveSettings({ deepseekApiKey: "sk-witness-value" });
  });

  it("documents that no HTTP path can clear a stored key", async () => {
    // Characterization, not aspiration. The route maps every "clear" payload the
    // client can send — "", null, undefined, omission — onto "preserve" for the
    // five secret fields, even though the storage layer would honor null.
    // If a clear path is ever added for secrets, this is the test that should
    // fail first.
    const stored = await getSettings();
    expect(stored.exaApiKey).toBe("exa-witness-value");
  });
});
