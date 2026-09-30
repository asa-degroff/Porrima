// Phase-2 maintenance trigger: the block inventory must cover EVERY project
// with active blocks — active projects get full per-block lines, dormant
// projects (no recent agent chat) get compact review lines — and the budget
// line counts all of them against the settings-derived block ceiling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentDate } from "../services/time-format.js";

interface FixtureBlock {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: "global" | "project" | "archived";
  projectId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  tokenEstimate: number;
  supersededBy?: string;
  supersedes?: string;
  blockType: string;
}

function block(
  id: string,
  name: string,
  updatedAt: string,
  over: Partial<FixtureBlock> = {},
): FixtureBlock {
  return {
    id,
    name,
    description: "desc",
    content: "x".repeat(1000),
    scope: "project",
    projectId: "p",
    createdAt: updatedAt,
    updatedAt,
    updatedBy: "agent",
    tokenEstimate: 250,
    blockType: "note",
    ...over,
  };
}

// Mutable fixture state, read by the module mocks.
const DEFAULT_BLOCK_TOKEN_BUDGETS = { global: 3000, project: 5000 };

const fixture: {
  globalBlocks: FixtureBlock[];
  blocksByProject: Map<string, FixtureBlock[]>;
  activeProjectIds: string[];
  projectIds: string[];
  projectNames: Record<string, string>;
  maxBlockCount: number;
  blockTokenBudgets: { global: number; project: number };
} = {
  globalBlocks: [],
  blocksByProject: new Map(),
  activeProjectIds: [],
  projectIds: [],
  projectNames: {},
  maxBlockCount: 15,
  blockTokenBudgets: DEFAULT_BLOCK_TOKEN_BUDGETS,
};

function loadTrigger() {
  vi.resetModules();
  // The chat database knows ONLY about chats. Querying memory_blocks against
  // it must fail loudly — the two stores are separate databases, and the
  // project list must come from the memory store (getAllMemoryBlocks).
  vi.doMock("../services/chat-storage.js", () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: (_arg?: unknown) => {
          if (sql.includes("FROM chats")) {
            return fixture.activeProjectIds.map((projectId) => ({ projectId }));
          }
          throw new Error(`chat db received unexpected query: ${sql}`);
        },
      }),
    }),
    getProject: async (id: string) => {
      const name = fixture.projectNames[id];
      if (!name) throw new Error("no such project");
      return { id, name };
    },
  }));
  vi.doMock("../services/memory-storage.js", () => {
    const desc = (a: FixtureBlock, b: FixtureBlock) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return {
      getMemoryBlocksByScope: (scope: string, projectId?: string) => {
        if (scope === "global") return [...fixture.globalBlocks].sort(desc);
        if (scope === "project" && projectId) {
          return [...(fixture.blocksByProject.get(projectId) ?? [])].sort(desc);
        }
        return [];
      },
      // Source of the project-id list: every non-superseded block, all scopes
      // (the trigger filters scope/projectId itself).
      getAllMemoryBlocks: () => [
        ...fixture.globalBlocks,
        ...[...fixture.blocksByProject.values()].flat(),
      ].sort(desc),
      getLastSynthesis: async () => null,
      getMaxBlockChars: async () => 9000,
      getMaxBlockCount: async () => fixture.maxBlockCount,
      getBlockTokenBudgets: async () => fixture.blockTokenBudgets,
      isSystemManagedMemoryBlock: (b: FixtureBlock) =>
        b.blockType === "zeitgeist" ||
        b.blockType === "notebook" ||
        b.scope === "archived",
    };
  });
  vi.doMock("../services/zeitgeist.js", () => ({
    getZeitgeistContent: () => "",
  }));
  const mod = import("../services/system-chat.js");
  return mod;
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
  fixture.globalBlocks = [];
  fixture.blocksByProject = new Map();
  fixture.activeProjectIds = [];
  fixture.projectIds = [];
  fixture.projectNames = {};
  fixture.maxBlockCount = 15;
});

const D = {
  g1: "2026-09-29T12:00:00Z",
  a1: "2026-09-29T11:00:00Z",
  a2: "2026-09-28T11:00:00Z",
  o1: "2026-09-18T11:00:00Z",
  o2: "2026-09-17T11:00:00Z",
  o3: "2026-09-16T11:00:00Z",
  n1: "2026-09-20T11:00:00Z",
};

describe("buildMaintenancePhase2Trigger inventory coverage", () => {
  it("renders full lines for active projects and compact review lines for dormant projects", async () => {
    fixture.globalBlocks = [block("blk-g1", "Global Block", D.g1, { scope: "global", projectId: "" })];
    fixture.activeProjectIds = ["pa"];
    fixture.projectIds = ["pa", "p-old", "p-new"];
    fixture.blocksByProject.set("pa", [
      block("blk-a1", "Active One", D.a1, { projectId: "pa" }),
      block("blk-a2", "Active Two", D.a2, { projectId: "pa" }),
    ]);
    fixture.blocksByProject.set("p-old", [
      block("blk-o1", "Old Newest", D.o1, { projectId: "p-old" }),
      block("blk-o2", "Old Middle", D.o2, { projectId: "p-old" }),
      block("blk-o3", "Old Oldest", D.o3, { projectId: "p-old" }),
      // system-managed (notebook) — must be filtered out of the count and the list
      block("blk-nb", "Old Notebook", D.o1, { projectId: "p-old", blockType: "notebook" }),
    ]);
    fixture.blocksByProject.set("p-new", [block("blk-n1", "New One", D.n1, { projectId: "p-new" })]);
    fixture.projectNames = { pa: "Active Project", "p-old": "Old Project" };

    const mod = await loadTrigger();
    const trigger = await mod.buildMaintenancePhase2Trigger("chat-1");

    // Active project keeps its full per-block section, with the resolved name.
    expect(trigger).toContain("**Active Project (pa):**");
    expect(trigger).toContain(
      `- [blk-a1] Active One — desc (updated ${formatAgentDate(D.a1)}, ~250t)`,
    );
    expect(trigger).toContain(
      `- [blk-a2] Active Two — desc (updated ${formatAgentDate(D.a2)}, ~250t)`,
    );

    // Dormant section exists and orders projects by oldest block first.
    expect(trigger).toContain(
      "**Dormant projects** (no recent agent chat — staleness review candidates):",
    );
    const oldLineIdx = trigger.indexOf("- Old Project (p-old):");
    const newLineIdx = trigger.indexOf("- p-new:");
    expect(oldLineIdx).toBeGreaterThan(-1);
    expect(newLineIdx).toBeGreaterThan(oldLineIdx);

    // Compact dormant line: count, oldest update, names oldest-first.
    expect(trigger).toContain(
      `- Old Project (p-old): 3 blocks, oldest updated ${formatAgentDate(D.o3)} — Old Oldest · Old Middle · Old Newest`,
    );
    expect(trigger).toContain(
      `- p-new: 1 blocks, oldest updated ${formatAgentDate(D.n1)} — New One`,
    );
    // Attached-status markers: 3 × 250t fits the 4,750t project remainder, so
    // every dormant block rides full in its project's chats.
    expect(trigger).toContain("(attached in Old Project chats: 3 full, 0 index)");
    expect(trigger).toContain("(attached in p-new chats: 1 full, 0 index)");
    // The notebook block was filtered: 3, not 4.
    expect(trigger).not.toContain("Old Notebook");
    expect(trigger).toContain("Active: 7/15 blocks");
    // 7 blocks × 1000 chars = 7,000 — far under the 135k budget: no alert.
    expect(trigger).not.toContain("Budget alert");

    // The trigger opens with the phase heading and still carries the
    // phase-2 maintenance instructions.
    expect(trigger.startsWith("## Phase 2: Memory Block Maintenance & Zeitgeist")).toBe(true);
    expect(trigger).toContain("### Block Maintenance");
  });

  it("uses the settings-derived block count in the budget line and alerts at 70%", async () => {
    fixture.globalBlocks = [block("blk-g1", "Global Block", D.g1, { scope: "global", projectId: "" })];
    fixture.activeProjectIds = ["pa"];
    fixture.projectIds = ["pa", "p-old"];
    fixture.blocksByProject.set("pa", [block("blk-a1", "Active One", D.a1, { projectId: "pa" })]);
    fixture.blocksByProject.set("p-old", [block("blk-o1", "Old One", D.o1, { projectId: "p-old" })]);

    // Default ceiling 15: 3 blocks (1 global + 1 active + 1 dormant), no alert.
    const mod1 = await loadTrigger();
    const t1 = await mod1.buildMaintenancePhase2Trigger("chat-1");
    expect(t1).toContain("Active: 3/15 blocks");
    expect(t1).not.toContain("Budget alert");

    // Tuned ceiling 7: the same 3 blocks sit under the 4.9 warning floor.
    fixture.maxBlockCount = 7;
    const mod2 = await loadTrigger();
    const t2 = await mod2.buildMaintenancePhase2Trigger("chat-1");
    expect(t2).toContain("Active: 3/7 blocks");
    expect(t2).not.toContain("Budget alert");

    // 7 of 7 blocks exceeds 70% of the ceiling — the alert fires.
    fixture.blocksByProject.set("p-old", [
      block("blk-o1", "Old One", D.o1, { projectId: "p-old" }),
      block("blk-o2", "Old Two", D.o2, { projectId: "p-old" }),
      block("blk-o3", "Old Three", D.o3, { projectId: "p-old" }),
      block("blk-o4", "Old Four", "2026-09-15T11:00:00Z", { projectId: "p-old" }),
      block("blk-o5", "Old Five", "2026-09-14T11:00:00Z", { projectId: "p-old" }),
    ]);
    const mod3 = await loadTrigger();
    const t3 = await mod3.buildMaintenancePhase2Trigger("chat-1");
    expect(t3).toContain("Active: 7/7 blocks");
    expect(t3).toContain("Budget alert");
  });

  it("marks attached status per block using the live prefix split", async () => {
    // Global: Small (250t, newest) fits the 3,000t budget; Big (4,000t, older)
    // doesn't — and sticky exhaustion means anything after it is index-only.
    fixture.globalBlocks = [
      block("blk-g-small", "Small Global", "2026-09-29T12:00:00Z", { scope: "global", projectId: "" }),
      block("blk-g-big", "Big Global", "2026-09-01T12:00:00Z", { scope: "global", projectId: "", tokenEstimate: 4000 }),
    ];
    // Active project: Small (250t) fits the 4,750t remainder; Big (6,000t) doesn't.
    fixture.activeProjectIds = ["pa"];
    fixture.blocksByProject.set("pa", [
      block("blk-a-small", "Small Active", "2026-09-29T11:00:00Z", { projectId: "pa" }),
      block("blk-a-big", "Big Active", "2026-09-01T11:00:00Z", { projectId: "pa", tokenEstimate: 6000 }),
    ]);

    const mod = await loadTrigger();
    const trigger = await mod.buildMaintenancePhase2Trigger("chat-1");

    expect(trigger).toContain(
      `- [blk-g-small] Small Global — desc (updated ${formatAgentDate("2026-09-29T12:00:00Z")}, ~250t) (rides full in all chats)`,
    );
    expect(trigger).toContain(
      `- [blk-g-big] Big Global — desc (updated ${formatAgentDate("2026-09-01T12:00:00Z")}, ~4000t) (index-only in all chats)`,
    );
    expect(trigger).toContain(
      `- [blk-a-small] Small Active — desc (updated ${formatAgentDate("2026-09-29T11:00:00Z")}, ~250t) (rides full in project chats)`,
    );
    expect(trigger).toContain(
      `- [blk-a-big] Big Active — desc (updated ${formatAgentDate("2026-09-01T11:00:00Z")}, ~6000t) (index-only in project chats)`,
    );
  });

  it("markers track the tuned settings budget, not the historical defaults", async () => {
    fixture.blockTokenBudgets = { global: 200, project: 2000 };
    try {
      // 250t (the block helper default) fits the historical 3000t global
      // default but NOT the tuned 200t budget — the marker must follow the
      // tuned value, or it would lie about the live attachment.
      fixture.globalBlocks = [
        block("blk-g-small", "Small Global", "2026-09-29T12:00:00Z", { scope: "global", projectId: "" }),
      ];
      fixture.activeProjectIds = ["pa"];
      fixture.blocksByProject.set("pa", [
        block("blk-a-small", "Small Active", "2026-09-29T11:00:00Z", { projectId: "pa" }),
        block("blk-a-big", "Big Active", "2026-09-01T11:00:00Z", { projectId: "pa", tokenEstimate: 4000 }),
      ]);

      const mod = await loadTrigger();
      const trigger = await mod.buildMaintenancePhase2Trigger("chat-1");

      expect(trigger).toContain(
        `- [blk-g-small] Small Global — desc (updated ${formatAgentDate("2026-09-29T12:00:00Z")}, ~250t) (index-only in all chats)`,
      );
      expect(trigger).toContain(
        `- [blk-a-small] Small Active — desc (updated ${formatAgentDate("2026-09-29T11:00:00Z")}, ~250t) (rides full in project chats)`,
      );
      // 250t loaded + 4000t > 2000t → sticky exhaustion, index-only.
      expect(trigger).toContain(
        `- [blk-a-big] Big Active — desc (updated ${formatAgentDate("2026-09-01T11:00:00Z")}, ~4000t) (index-only in project chats)`,
      );
    } finally {
      fixture.blockTokenBudgets = DEFAULT_BLOCK_TOKEN_BUDGETS;
    }
  });

  it("truncates dormant name lists at 10 with a +N more suffix", async () => {
    const many: FixtureBlock[] = [];
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i, 11)).toISOString();
      many.push(block(`blk-d${i}`, `Dormant Block ${i.toString().padStart(2, "0")}`, d, { projectId: "p-many" }));
    }
    fixture.projectIds = ["p-many"];
    fixture.blocksByProject.set("p-many", many);

    const mod = await loadTrigger();
    const trigger = await mod.buildMaintenancePhase2Trigger("chat-1");

    const line = trigger.split("\n").find((l) => l.startsWith("- p-many:"));
    expect(line).toBeDefined();
    expect(line).toContain("12 blocks");
    expect(line).toContain("+2 more");
    expect(line).toContain("Dormant Block 01"); // oldest first
    expect(line).not.toContain("Dormant Block 11");
    expect(line).not.toContain("Dormant Block 12");
    const nameCount = (line?.match(/Dormant Block \d\d/g) ?? []).length;
    expect(nameCount).toBe(10);
  });

  it("omits projects whose only blocks are system-managed", async () => {
    fixture.projectIds = ["p-notebooks"];
    fixture.blocksByProject.set("p-notebooks", [
      block("blk-n1", "Only Notebook", D.n1, { projectId: "p-notebooks", blockType: "notebook" }),
    ]);

    const mod = await loadTrigger();
    const trigger = await mod.buildMaintenancePhase2Trigger("chat-1");

    expect(trigger).not.toContain("Dormant projects");
    expect(trigger).not.toContain("Only Notebook");
    expect(trigger).toContain("Active: 0/15 blocks");
  });
});
