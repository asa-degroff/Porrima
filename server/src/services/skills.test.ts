import { describe, expect, it } from "vitest";
import { buildSkillAugmentedPrompt, stripActiveSkillsSection, type Skill } from "./skills.js";

const skill: Skill = {
  name: "test-skill",
  description: "Test skill",
  instructions: "Use the test skill instructions.",
  folderPath: "/tmp/test-skill",
  source: "global",
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
});
