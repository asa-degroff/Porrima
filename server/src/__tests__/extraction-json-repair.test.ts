import { describe, it, expect } from "vitest";
import {
  parseExtractionResponse,
  repairExtractionJson,
  callExtractionLLMParsed,
  type ExtractionDialogueMessage,
} from "../services/memory-extraction.js";

describe("parseExtractionResponse status", () => {
  it("classifies a parsed non-empty result as ok", () => {
    const result = parseExtractionResponse(`{"subject": "S", "memories": [{"text": "fact", "category": "fact", "importance": 7}]}`);
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  it("classifies an intentional empty wrapper as empty", () => {
    expect(parseExtractionResponse(`{"subject": "", "memories": []}`).status).toBe("empty");
    expect(parseExtractionResponse("[]").status).toBe("empty");
  });

  it("classifies unparseable prose as invalid with a reason", () => {
    const result = parseExtractionResponse("I could not find anything worth saving.");
    expect(result.status).toBe("invalid");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.facts).toEqual([]);
  });

  it("classifies truncated JSON as invalid", () => {
    const result = parseExtractionResponse(`{"subject": "S", "memories": [{"text": "one", "category": "fact", "importance": 3}, {"text": "cut hea`);
    expect(result.status).toBe("invalid");
  });

  it("classifies a wrapper with malformed items as invalid, not empty", () => {
    const result = parseExtractionResponse(`{"subject": "S", "memories": [{"category": "fact", "importance": 3}]}`);
    expect(result.status).toBe("invalid");
    expect(result.errors.join(" ")).toContain("text");
  });

  it("classifies a wrapper with a non-array memories field as invalid", () => {
    const result = parseExtractionResponse(`{"subject": "S", "memories": "none"}`);
    expect(result.status).toBe("invalid");
    expect(result.errors.join(" ")).toContain("array");
  });

  it("normalizes missing and out-of-range importance", () => {
    const result = parseExtractionResponse(
      `{"subject": "S", "memories": [
        {"text": "missing imp", "category": "fact"},
        {"text": "string imp", "category": "fact", "importance": "8"},
        {"text": "huge imp", "category": "fact", "importance": 42},
        {"text": "nan imp", "category": "fact", "importance": "high"}
      ]}`,
    );
    expect(result.facts.map((f) => f.importance)).toEqual([5, 8, 10, 5]);
  });
});

describe("repairExtractionJson", () => {
  it("returns null when there is no JSON to repair", () => {
    expect(repairExtractionJson("no json here")).toBeNull();
    expect(repairExtractionJson("")).toBeNull();
  });

  it("passes through already-valid JSON", () => {
    const input = `{"subject": "S", "memories": [{"text": "a", "category": "fact", "importance": 5}]}`;
    expect(repairExtractionJson(input)).toBe(input);
  });

  it("closes truncation mid-string and keeps completed memories", () => {
    const broken = `{"subject": "KV caching", "memories": [{"text": "First complete fact.", "category": "fact", "importance": 7}, {"text": "Second fact cuts off mid-fl`;
    const repaired = repairExtractionJson(broken);
    expect(repaired).not.toBeNull();
    const parsed = parseExtractionResponse(repaired!);
    expect(parsed.status).toBe("ok");
    expect(parsed.facts.length).toBeGreaterThanOrEqual(1);
    expect(parsed.facts[0].text).toBe("First complete fact.");
  });

  it("salvages by dropping the incomplete element when a key is dangling", () => {
    const broken = `{"subject": "S", "memories": [{"text": "kept fact", "category": "note", "importance": 4}, {"text": "done", "category": "note", "importance": 4, "sub`;
    const repaired = repairExtractionJson(broken);
    const parsed = parseExtractionResponse(repaired!);
    expect(parsed.status).toBe("ok");
    expect(parsed.facts).toHaveLength(2);
  });

  it("fixes trailing commas", () => {
    const broken = `{"subject": "S", "memories": [{"text": "a", "category": "fact", "importance": 5,},],}`;
    const repaired = repairExtractionJson(broken);
    expect(repaired).not.toBeNull();
    expect(parseExtractionResponse(repaired!).facts).toHaveLength(1);
  });

  it("escapes raw newlines inside string values", () => {
    const broken = '{"subject": "S", "memories": [{"text": "line one\nline two", "category": "fact", "importance": 5}]}';
    const repaired = repairExtractionJson(broken);
    expect(repaired).not.toBeNull();
    const parsed = parseExtractionResponse(repaired!);
    expect(parsed.status).toBe("ok");
    expect(parsed.facts[0].text).toBe("line one\nline two");
  });

  it("normalizes smart quotes used as JSON delimiters", () => {
    const broken = "{\u201Csubject\u201D: \u201CS\u201D, \u201Cmemories\u201D: [{\u201Ctext\u201D: \u201Ca fact\u201D, \u201Ccategory\u201D: \u201Cfact\u201D, \u201Cimportance\u201D: 5}]}";
    const repaired = repairExtractionJson(broken);
    expect(repaired).not.toBeNull();
    expect(parseExtractionResponse(repaired!).facts).toHaveLength(1);
  });
});

function userMsg(content: string): ExtractionDialogueMessage {
  return { role: "user", content };
}

describe("callExtractionLLMParsed", () => {
  const VALID = `{"subject": "S", "memories": [{"text": "a fact", "category": "fact", "importance": 6}]}`;
  const TRUNCATED = `{"subject": "S", "memories": [{"text": "good fact", "category": "fact", "importance": 6}, {"text": "cut mid-stri`;
  const GARBAGE = "I'm not really able to produce JSON right now, sorry!";

  it("returns the parse without retrying on valid output", async () => {
    const calls: ExtractionDialogueMessage[][] = [];
    const result = await callExtractionLLMParsed({
      messages: [userMsg("extract this")],
      retryContext: "test",
      callWithMessages: async (messages) => {
        calls.push(messages);
        return VALID;
      },
    });
    expect(result.parse.status).toBe("ok");
    expect(result.rawOutput).toBe(VALID);
    expect(calls).toHaveLength(1);
    expect(result.health).toMatchObject({ invalidResponses: 0, localRepairs: 0, repairRetries: 0, repairRecoveries: 0, unrecovered: 0 });
  });

  it("rescues truncated JSON locally without a second call", async () => {
    const calls: ExtractionDialogueMessage[][] = [];
    const result = await callExtractionLLMParsed({
      messages: [userMsg("extract this")],
      retryContext: "test",
      callWithMessages: async (messages) => {
        calls.push(messages);
        return TRUNCATED;
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.parse.status).toBe("ok");
    expect(result.parse.facts[0].text).toBe("good fact");
    expect(result.rawOutput).not.toBe(TRUNCATED); // repaired text anchors session history
    expect(JSON.parse(result.rawOutput)).toBeTruthy();
    expect(result.health).toMatchObject({ invalidResponses: 1, localRepairs: 1, repairRetries: 0 });
  });

  it("issues a feedback retry with echo + instruction and counts recovery", async () => {
    const calls: ExtractionDialogueMessage[][] = [];
    const result = await callExtractionLLMParsed({
      messages: [userMsg("extract this")],
      retryContext: "test",
      maxRepairRetries: 1,
      callWithMessages: async (messages) => {
        calls.push(messages);
        return calls.length === 1 ? GARBAGE : VALID;
      },
    });
    expect(calls).toHaveLength(2);
    expect(result.parse.status).toBe("ok");
    expect(result.rawOutput).toBe(VALID);
    expect(result.health).toMatchObject({ invalidResponses: 1, repairRetries: 1, repairRecoveries: 1, unrecovered: 0 });

    // The repair turn echoes the broken output as an assistant message and
    // follows with a user instruction referencing the parse failure.
    const repairWindow = calls[1];
    expect(repairWindow.length).toBeGreaterThan(calls[0].length);
    const tail = repairWindow.slice(calls[0].length);
    expect(tail.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(tail[0].content).toBe(GARBAGE);
    expect(tail[1].content).toContain("could not be parsed");
    expect(tail[1].content).toContain("Re-emit");
  });

  it("gives up after the retry limit and reports invalid", async () => {
    const calls: ExtractionDialogueMessage[][] = [];
    const result = await callExtractionLLMParsed({
      messages: [userMsg("extract this")],
      retryContext: "test",
      maxRepairRetries: 2,
      callWithMessages: async (messages) => {
        calls.push(messages);
        return `${GARBAGE} attempt ${calls.length}`;
      },
    });
    expect(calls).toHaveLength(3); // original + 2 repair attempts
    expect(result.parse.status).toBe("invalid");
    expect(result.parse.facts).toEqual([]);
    expect(result.health).toMatchObject({ invalidResponses: 3, repairRetries: 2, repairRecoveries: 0, unrecovered: 1 });
  });

  it("treats a failing repair call as no worse than the status quo", async () => {
    let first = true;
    const result = await callExtractionLLMParsed({
      messages: [userMsg("extract this")],
      retryContext: "test",
      maxRepairRetries: 2,
      callWithMessages: async () => {
        if (first) {
          first = false;
          return GARBAGE;
        }
        throw new Error("extraction server exploded");
      },
    });
    expect(result.parse.status).toBe("invalid");
    expect(result.health).toMatchObject({ repairRetries: 1, repairRecoveries: 0 });
  });

  it("counts an intentional empty retry output as a recovery", async () => {
    let n = 0;
    const result = await callExtractionLLMParsed({
      messages: [userMsg("extract this")],
      retryContext: "test",
      maxRepairRetries: 1,
      callWithMessages: async () => (n++ === 0 ? GARBAGE : `{"subject": "", "memories": []}`),
    });
    expect(result.parse.status).toBe("empty");
    expect(result.health).toMatchObject({ invalidResponses: 1, repairRetries: 1, repairRecoveries: 1 });
  });
});
