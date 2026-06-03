import { describe, expect, it } from "vitest";
import { buildSkillAugmentedPrompt, parseSkillFile, stripActiveSkillsSection, type Skill } from "./skills.js";

const skill: Skill = {
  name: "test-skill",
  description: "Test skill",
  compatibility: "Requires Python 3.14+ and uv",
  allowedTools: "Bash(git:*) Read",
  resources: {
    scripts: ["scripts/extract.py"],
    references: ["references/REFERENCE.md"],
  },
  instructions: "Use the test skill instructions.",
  folderPath: "/tmp/test-skill",
  source: "global",
  sourceRoot: "porrima",
  managed: true,
};

function cacheWithTestSkill(): Map<string, Skill> {
  return new Map([[skill.name, skill]]);
}

describe("skill prompt augmentation", () => {
  it("is idempotent when called with an already augmented prompt", () => {
    const basePrompt = "You are a helpful assistant.";
    const once = buildSkillAugmentedPrompt(basePrompt, [skill.name], cacheWithTestSkill());
    const twice = buildSkillAugmentedPrompt(once, [skill.name], cacheWithTestSkill());

    expect(twice).toBe(once);
    expect(twice.match(/\[Active Skills\]/g)).toHaveLength(1);
  });

  it("collapses prompts that already contain duplicated active skill sections", () => {
    const basePrompt = "You are a helpful assistant.";
    const once = buildSkillAugmentedPrompt(basePrompt, [skill.name], cacheWithTestSkill());
    const duplicated = `${once}\n\n[Active Skills]\n## Skill: stale\nold instructions\n`;
    const rebuilt = buildSkillAugmentedPrompt(duplicated, [skill.name], cacheWithTestSkill());

    expect(rebuilt).toBe(once);
    expect(rebuilt.match(/\[Active Skills\]/g)).toHaveLength(1);
    expect(rebuilt).not.toContain("old instructions");
  });

  it("removes stale active skill sections when no skills are active", () => {
    const augmented = buildSkillAugmentedPrompt("Base", [skill.name], cacheWithTestSkill());

    expect(buildSkillAugmentedPrompt(augmented, [], cacheWithTestSkill())).toBe("Base");
  });

  it("does not append an empty active skills section for stale skill names", () => {
    const rebuilt = buildSkillAugmentedPrompt("Base", ["missing-skill"], cacheWithTestSkill());

    expect(rebuilt).toBe("Base");
  });

  it("strips from the first active skills section", () => {
    const prompt = "Base\n\n[Active Skills]\nfirst\n\n[Active Skills]\nsecond";

    expect(stripActiveSkillsSection(prompt)).toBe("Base");
  });

  it("includes skill root and optional resources for progressive disclosure", () => {
    const augmented = buildSkillAugmentedPrompt("Base", [skill.name], cacheWithTestSkill());

    expect(augmented).toContain("Skill root: /tmp/test-skill");
    expect(augmented).toContain("Allowed tools requested by skill: Bash(git:*) Read");
    expect(augmented).toContain("Optional skill resources: scripts/extract.py, references/REFERENCE.md");
  });
});

describe("skill frontmatter parsing", () => {
  it("parses Agent Skills spec fields", () => {
    const parsed = parseSkillFile(`---
name: test-skill
description: |
  Use this when a task needs tests # not a comment.
  Load references only when needed.
license: MIT
compatibility: Requires Python 3.14+ and uv
allowed-tools: Bash(git:*) Read
metadata:
  author: example-org
  version: "1.0"
---

# Test Skill
`);

    expect(parsed?.frontmatter).toEqual({
      name: "test-skill",
      description: "Use this when a task needs tests # not a comment.\nLoad references only when needed.",
      license: "MIT",
      compatibility: "Requires Python 3.14+ and uv",
      allowedTools: "Bash(git:*) Read",
      metadata: {
        author: "example-org",
        version: "1.0",
      },
    });
    expect(parsed?.body).toContain("# Test Skill");
  });
});
