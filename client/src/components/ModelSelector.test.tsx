// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "./ModelSelector";

const models = [
  { id: "m1", name: "Alpha Model", provider: "llamacpp" },
  { id: "m2", name: "Beta Model", provider: "llamacpp", parameterSize: "7B" },
] as any;

describe("ModelSelector with shared depth dropdown", () => {
  it("opens, selects a model, and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelSelector models={models} selectedId="m1" onChange={onChange} />);

    const trigger = screen.getAllByRole("button", { name: /alpha model/i })[0];
    await user.click(trigger);

    const option = await screen.findByRole("button", { name: /beta model/i });
    expect(option).toBeTruthy();
    await user.click(option);

    expect(onChange).toHaveBeenCalledWith("m2");
    expect(screen.queryByRole("button", { name: /beta model/i })).toBeNull();
  });

  it("renders the raised trigger and keeps scrolling on the panel content", async () => {
    const user = userEvent.setup();
    render(<ModelSelector models={models} selectedId="m1" onChange={() => {}} />);
    const trigger = screen.getAllByRole("button", { name: /alpha model/i })[0];
    expect(trigger.className).toContain("depth-raised");
    await user.click(trigger);
    const panel = document.querySelector(".animate-dropdown-enter") as HTMLElement;
    expect(panel.className).toContain("depth-raised");
    expect(panel.className).not.toContain("overflow-y-auto");
    expect((panel.firstElementChild as HTMLElement).className).toContain("overflow-y-auto");
  });
});
