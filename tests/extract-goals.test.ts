import { describe, it, expect } from "bun:test";
import { extractGoals } from "../src/extract/goals";
import type { NormalizedBlock } from "../src/types";

describe("extractGoals", () => {
  it("returns empty for no blocks", () => {
    expect(extractGoals([])).toEqual([]);
  });

  it("returns empty when no user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "hello" },
    ];
    expect(extractGoals(blocks)).toEqual([]);
  });

  it("extracts first user message lines as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug\nCheck auth flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Original user request: Fix login bug"]);
  });

  it("takes up to 6 lines from first user block", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "fix the login bug\ncheck auth flow\nupdate the tests\nrefactor utils\nclean up" },
    ];
    expect(extractGoals(blocks)).toEqual(["Original user request: fix the login bug"]);
  });

  it("ignores subsequent user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "first goal" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "second request" },
    ];
    expect(extractGoals(blocks)).toEqual(["Original user request: first goal"]);
  });

  it("detects scope change with explicit pivot keywords", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Actually, instead let's refactor the auth module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals.some((g) => g.includes("Fix login bug"))).toBe(true);
    expect(goals.some((g) => g.includes("Latest substantive user direction"))).toBe(true);
    expect(goals.some((g) => g.includes("refactor"))).toBe(true);
  });

  it("detects scope change from new task statements", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Now implement the user registration flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals.some((g) => g.includes("Latest substantive user direction"))).toBe(true);
  });

  it("keeps latest scope change only", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Actually, fix the signup page instead" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Change of plan, implement password reset" },
    ];
    const goals = extractGoals(blocks);
    expect(goals[0]).toContain("password reset");
  });

  it("skips noise short user messages as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "ok" },
      { kind: "assistant", text: "hello" },
      { kind: "user", text: "Fix the authentication module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals[0]).toContain("Fix the authentication");
    expect(goals.some((g) => g === "ok")).toBe(false);
  });

  it("selects a research mandate from a long handoff rather than its metadata", () => {
    const handoff = "Handoff: broad EO research\nDate: October 2026\nRepo: stationer-research\n## 1. Mandate\nEvaluate learned earth embeddings for wind downscaling on unseen stations.\n" + "Data inventory detail.\n".repeat(850);
    const goals = extractGoals([{ kind: "user", text: handoff, sourceIndex: 17 }]);
    expect(goals).toEqual(["Original user request (#17): Evaluate learned earth embeddings for wind downscaling on unseen stations."]);
  });

  it("keeps a handoff-file pointer when the contents are external", () => {
    expect(extractGoals([{kind:"user",text:"read and execute outputs/research-handoff.md",sourceIndex:4}]))
      .toEqual(["Original user request (#4): read and execute outputs/research-handoff.md"]);
  });

  it("prioritizes a new research question over an old campaign without inventing supersession", () => {
    const blocks: NormalizedBlock[] = [
      { kind:"user",text:"Evaluate the G1 embedding scout qualification",sourceIndex:4 },
      { kind:"assistant",text:"Run G1" },
      { kind:"user",text:"Let me propose a new idea - what if we evaluate TESSERA as a substitute for topo to reduce unseen-station overfitting?",sourceIndex:22 },
      { kind:"user",text:"Go ahead",sourceIndex:24 },
      { kind:"user",text:"check it",sourceIndex:25 },
    ];
    const goals = extractGoals(blocks);
    expect(goals[0]).toContain("Latest user proposal (#22)");
    expect(goals[0]).toContain("what if we evaluate TESSERA");
    expect(goals.some((g) => g.includes("Subsequent user response (#24): Go ahead"))).toBe(true);
    expect(goals[2]).toContain("Earlier user request (#4)");
    expect(goals.join(" ")).not.toContain("(#25)");
  });

  it("does not mistake a handoff title for its unheaded research instruction", () => {
    const text = "Handoff: research in a new session\nDate: October 2026\nRepository: stationer-research\n## Background\nEarlier work covered embeddings.\nFind alternative features that improve spatial generalization.\n";
    expect(extractGoals([{ kind:"user", text, sourceIndex:2 }])[0]).toBe(
      "Original user request (#2): Find alternative features that improve spatial generalization.");
  });

  it("ignores review-status and repository metadata in long unheaded handoffs", () => {
    const text = "Handoff: a new research task\nRepo: stationer-research\n## Research question\n## Review status\nCompare new landscape embeddings on unseen weather stations.\n";
    expect(extractGoals([{ kind:"user", text }])[0]).toBe(
      "Original user request: Compare new landscape embeddings on unseen weather stations.");
  });

  it("uses an inline mandate rather than the following section", () => {
    const text = "Handoff: long research assignment\nRepo: stationer-research\nMandate: Investigate whether earth embeddings reduce topo overfitting\nBackground: Existing G1 adjudication\n";
    expect(extractGoals([{ kind:"user", text }])[0]).toBe(
      "Original user request: Investigate whether earth embeddings reduce topo overfitting");
  });

  it("preserves a bare what-if research proposal as tentative", () => {
    const goals = extractGoals([
      { kind: "user", text:"Inspect the prior research evidence", sourceIndex:2 },
      { kind: "user", text:"What if we replace terrain features with satellite embeddings?", sourceIndex:8 },
      { kind: "user", text:"Proceed", sourceIndex:9 },
    ]);
    expect(goals[0]).toContain("Latest user proposal (#8): What if we replace terrain");
    expect(goals[1]).toContain("Subsequent user response (#9): Proceed");
  });
});
