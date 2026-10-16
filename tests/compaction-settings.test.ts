import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCompactionSettings } from "../src/commands/compaction-settings";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vcc-tui-threshold-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  const config = {
    packages: ["keep this package"],
    theme: "custom",
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      modelOverrides: {
        "openai-codex/gpt-6.1-sol": { reserveTokens: 200000, keepRecentTokens: 25000 },
        "opencode-go/claude-haiku-5-5": { reserveTokens: 100000 },
      },
    },
  };
  writeFileSync(path, JSON.stringify(config));
  const read = (): typeof config => JSON.parse(readFileSync(path, "utf8"));
  return { path, config, read };
}

function harness(choices: string[], inputs: Array<string | undefined> = [], opts: { model?: { provider: string; id: string; contextWindow: number }; hasUI?: boolean; reloadFails?: boolean } = {}) {
  const seen: string[][] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  let reloads = 0;
  const ctx = {
    hasUI: opts.hasUI ?? true,
    model: opts.model ?? { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 1_000_000 },
    modelRegistry: {
      find: (provider: string, id: string) =>
        id === "claude-haiku-5-5" && provider === "opencode-go"
          ? { contextWindow: 1_000_000 }
          : undefined,
    },
    ui: {
      select: async (_title: string, options: string[]) => {
        seen.push(options);
        const requested = choices.shift();
        return requested === undefined ? undefined : options.find((option) => option.includes(requested));
      },
      input: async () => inputs.shift(),
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
    reload: async () => {
      reloads++;
      if (opts.reloadFails) throw new Error("reload unavailable");
    },
  };
  return { ctx: ctx as any, seen, notifications, get reloads() { return reloads; } };
}

const run = (ctx: any, path: string) => openCompactionSettings(ctx, path, "1.2.0");

describe("/pi-vcc settings TUI", () => {
  test("sets a current model's used-token threshold by converting to Pi reserveTokens", async () => {
    const { path, read } = fixture();
    const h = harness(["Current ·", "Compact after used tokens"], ["200k"]);
    await run(h.ctx, path);
    expect(h.seen[0].join(" ")).toContain("after 800,000");
    expect(read().compaction.modelOverrides["openai-codex/gpt-6.1-sol"]).toEqual({
      reserveTokens: 800000, keepRecentTokens: 25000,
    });
    expect(read().compaction.reserveTokens).toBe(16384);
    expect(read().compaction.modelOverrides["opencode-go/claude-haiku-5-5"].reserveTokens).toBe(100000);
    expect(read().packages).toEqual(["keep this package"]);
    expect(h.reloads).toBe(1);
    expect(h.notifications.at(-1)?.level).toBe("info");
  });

  test("edits an existing alternate-model headroom without switching models", async () => {
    const { path, read } = fixture();
    const h = harness(["opencode-go/claude-haiku-5-5", "Headroom reserve"], ["150k"]);
    await run(h.ctx, path);
    expect(read().compaction.modelOverrides["opencode-go/claude-haiku-5-5"].reserveTokens).toBe(150000);
    expect(h.reloads).toBe(1);
  });

  test("sets the global headroom while preserving all model overrides", async () => {
    const { path, read } = fixture();
    const h = harness(["Global default", "Headroom reserve"], ["48,000"]);
    await run(h.ctx, path);
    expect(read().compaction.reserveTokens).toBe(48000);
    expect(read().compaction.modelOverrides["openai-codex/gpt-6.1-sol"].reserveTokens).toBe(200000);
  });

  test("removes only the model reserve override and retains the keepRecentTokens setting", async () => {
    const { path, read } = fixture();
    const h = harness(["Current ·", "Use inherited global default"]);
    await run(h.ctx, path);
    expect(read().compaction.modelOverrides["openai-codex/gpt-6.1-sol"]).toEqual({ keepRecentTokens: 25000 });
    expect(h.reloads).toBe(1);
  });

  test("does not save invalid input or reload", async () => {
    const { path, config, read } = fixture();
    const h = harness(["Current ·", "Compact after used tokens"], ["1.2m"]);
    await run(h.ctx, path);
    expect(read()).toEqual(config);
    expect(h.reloads).toBe(0);
    expect(h.notifications.at(-1)?.level).toBe("warning");
  });

  test("cancel, missing UI, and corrupt JSON all avoid writing", async () => {
    const { path, config, read } = fixture();
    await run(harness([]).ctx, path);
    await run(harness([], [], { hasUI: false }).ctx, path);
    expect(read()).toEqual(config);
    writeFileSync(path, "{ broken json");
    const h = harness(["Current ·", "Headroom reserve"], ["100k"]);
    await run(h.ctx, path);
    expect(readFileSync(path, "utf8")).toBe("{ broken json");
    expect(h.notifications.at(-1)?.level).toBe("error");
  });

  test("a failed Pi reload reports saved-but-not-active status", async () => {
    const { path, read } = fixture();
    const h = harness(["Current ·", "Headroom reserve"], ["300k"], { reloadFails: true });
    await expect(run(h.ctx, path)).rejects.toThrow("Settings saved, but reload failed");
    expect(read().compaction.modelOverrides["openai-codex/gpt-6.1-sol"].reserveTokens).toBe(300000);
    expect(h.notifications.at(-1)?.message).toContain("reloading Pi settings");
  });

  test("older Pi versions expose global settings only", async () => {
    const { path, read, config } = fixture();
    const h = harness(["Cancel"]);
    await openCompactionSettings(h.ctx, path, "0.85.1");
    expect(h.seen[0]).toHaveLength(2); // global default + cancel
    expect(h.seen[0][0]).toContain("Global default");
    expect(h.notifications[0]?.message).toContain("Pi 1.2+");
    expect(read()).toEqual(config);
  });

  test("a global reserve greater than the current context window is rejected", async () => {
    const { path, read, config } = fixture();
    const h = harness(["Global default", "Headroom reserve"], ["1m"], {
      model: { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 272000 },
    });
    await run(h.ctx, path);
    expect(read()).toEqual(config);
    expect(h.notifications.at(-1)?.level).toBe("warning");
  });

  test("an existing project-model override is shown as taking precedence", async () => {
    const { path, read } = fixture();
    const dir = join(path, "..");
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({
      compaction: { modelOverrides: { "openai-codex/gpt-6.1-sol": { reserveTokens: 700000 } } },
    }));
    const h = harness(["Current ·", "Headroom reserve"], ["250k"]);
    h.ctx.cwd = dir;
    h.ctx.isProjectTrusted = () => true;
    await run(h.ctx, path);
    expect(h.seen[0].join(" ")).toContain("project override active");
    expect(h.notifications.at(-1)?.message).toContain("project-local override");
    expect(read().compaction.modelOverrides["openai-codex/gpt-6.1-sol"].reserveTokens).toBe(250000);
  });

  test("a competing Pi settings writer's lock prevents clobbering", async () => {
    const { path, read, config } = fixture();
    mkdirSync(`${path}.lock`);
    const h = harness(["Current ·", "Headroom reserve"], ["250k"]);
    await run(h.ctx, path);
    expect(h.notifications.at(-1)?.message).toContain("busy");
    expect(read()).toEqual(config);
    expect(h.reloads).toBe(0);
  });

  test("an abandoned stale lock is recovered via Pi's lock implementation", async () => {
    const { path, read } = fixture();
    mkdirSync(`${path}.lock`);
    const stale = new Date(Date.now() - 40_000);
    utimesSync(`${path}.lock`, stale, stale);
    const h = harness(["Current ·", "Headroom reserve"], ["180k"]);
    await run(h.ctx, path);
    expect(read().compaction.modelOverrides["openai-codex/gpt-6.1-sol"].reserveTokens).toBe(180000);
    expect(h.reloads).toBe(1);
  });

  test("project-only model settings are visible even if there is no global override", async () => {
    const { path } = fixture();
    const dir = join(path, "..");
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({
      compaction: { modelOverrides: { "claude-bridge/claude-opus-5-5": { reserveTokens: 200000 } } },
    }));
    const h = harness(["Cancel"]);
    h.ctx.cwd = dir;
    h.ctx.isProjectTrusted = () => true;
    await run(h.ctx, path);
    expect(h.seen[0].join(" ")).toContain("claude-bridge/claude-opus-5-5 — reserve");
    expect(h.seen[0].join(" ")).toContain("project override active");
  });

  test("blank input is an unchanged value, not an error or a write", async () => {
    const { path, read, config } = fixture();
    const h = harness(["Current ·", "Headroom reserve"], [""]);
    await run(h.ctx, path);
    expect(read()).toEqual(config);
    expect(h.reloads).toBe(0);
    expect(h.notifications.at(-1)?.message).toContain("unchanged");
  });

  test("blank input also preserves Pi-valid boundary reserves", async () => {
    for (const value of [0, 1_000_000]) {
      const { path, read } = fixture();
      const cfg = read();
      cfg.compaction.modelOverrides["openai-codex/gpt-6.1-sol"].reserveTokens = value;
      writeFileSync(path, JSON.stringify(cfg));
      const h = harness(["Current ·", "Headroom reserve"], [""]);
      await run(h.ctx, path);
      expect(read()).toEqual(cfg);
      expect(h.reloads).toBe(0);
      expect(h.notifications.at(-1)?.message).toContain("unchanged");
    }
  });

  test("a null existing reserve is reported as invalid instead of silently inherited", async () => {
    const { path, read } = fixture();
    const corrupted = read() as any;
    corrupted.compaction.reserveTokens = null;
    writeFileSync(path, JSON.stringify(corrupted));
    const h = harness(["Global default", "Headroom reserve"], ["100k"]);
    await run(h.ctx, path);
    expect(read().compaction.reserveTokens).toBeNull();
    expect(h.notifications.at(-1)?.level).toBe("error");
  });
});
