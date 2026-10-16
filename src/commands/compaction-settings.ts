import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, VERSION, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

// Pi owns the threshold. VCC only supplies the compaction implementation, so
// this menu edits Pi's existing settings rather than introducing another knob.
const DEFAULT_RESERVE = 16_384;
const settingsPath = () => join(getAgentDir(), "settings.json");
const supportsModelOverrides = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 2);
};

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readConfig = (path: string): JsonObject => {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) throw new Error("Pi settings must be a JSON object");
  return parsed;
};

const compactionOf = (config: JsonObject): JsonObject => {
  if (config.compaction === undefined) return {};
  if (!isObject(config.compaction)) throw new Error("Invalid Pi compaction settings");
  return config.compaction;
};

const overridesOf = (compaction: JsonObject): JsonObject => {
  if (compaction.modelOverrides === undefined) return {};
  if (!isObject(compaction.modelOverrides)) throw new Error("Invalid Pi model overrides");
  return compaction.modelOverrides;
};

const reserveOf = (compaction: JsonObject, modelKey: string | null): number => {
  const overrides = overridesOf(compaction);
  const entry = modelKey ? overrides[modelKey] : undefined;
  if (entry !== undefined && !isObject(entry)) throw new Error(`Invalid override for ${modelKey}`);
  const modelReserve = (entry as JsonObject | undefined)?.reserveTokens;
  const reserve = modelReserve !== undefined ? modelReserve
    : compaction.reserveTokens !== undefined ? compaction.reserveTokens : DEFAULT_RESERVE;
  if (typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve < 0) {
    throw new Error("Invalid existing reserveTokens setting");
  }
  return reserve;
};

const tokenCount = (input: string): number | undefined => {
  const match = input.trim().replace(/[,_ ]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!match) return;
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1_000 : 1;
  const value = Number(match[1]) * multiplier;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const format = (n: number): string => n.toLocaleString("en-US");

const saveReserve = async (path: string, modelKey: string | null, reserve: number | null): Promise<void> => {
  // Use the exact lock implementation and policy employed by Pi's own
  // FileSettingsStorage (including stale-lock and crash recovery).
  mkdirSync(dirname(path), { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 20 } });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("Pi settings are busy; retry the change");
    throw err;
  }
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const config = readConfig(path);
    const compaction = { ...compactionOf(config) };
    if (modelKey === null) {
      if (reserve === null) throw new Error("The global reserve cannot be removed here");
      compaction.reserveTokens = reserve;
    } else {
      const overrides = { ...overridesOf(compaction) };
      const previous = overrides[modelKey];
      if (previous !== undefined && !isObject(previous)) throw new Error(`Invalid override for ${modelKey}`);
      const entry: JsonObject = { ...(previous as JsonObject | undefined) };
      if (reserve === null) delete entry.reserveTokens;
      else entry.reserveTokens = reserve;
      if (Object.keys(entry).length) overrides[modelKey] = entry;
      else delete overrides[modelKey];
      compaction.modelOverrides = overrides;
    }
    config.compaction = compaction;
    let mode = 0o600;
    try { mode = statSync(path).mode & 0o777; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: "wx" });
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* no temporary file on early failure */ }
    throw err;
  } finally {
    await release();
  }
};

/** Interactive global Pi compaction settings; Pi's project settings may take precedence. */
export async function openCompactionSettings(
  ctx: ExtensionCommandContext,
  path = settingsPath(),
  hostVersion = VERSION,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/pi-vcc settings requires an interactive UI", "warning");
    return;
  }

  let saved = false;
  try {
    const compaction = compactionOf(readConfig(path));
    const overrides = overridesOf(compaction);
    if (compaction.enabled === false) {
      ctx.ui.notify("Pi auto-compaction is disabled; enable it in /settings for these limits to take effect", "warning");
    }
    const modelOverridesSupported = supportsModelOverrides(hostVersion);
    const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const projectPath = ctx.cwd ? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json") : undefined;
    const project = projectPath && ctx.isProjectTrusted?.() !== false
      ? compactionOf(readConfig(projectPath)) : {};
    const projectOverrides = overridesOf(project);
    const keys = modelOverridesSupported
      ? [...new Set([currentKey, ...Object.keys(overrides), ...Object.keys(projectOverrides)].filter((s): s is string => !!s))]
      : [];
    if (!modelOverridesSupported) ctx.ui.notify("This Pi version supports global compaction limits only (per-model settings need Pi 1.2+)", "info");
    const isProjectOverride = (modelKey: string | null): boolean => {
      if (modelKey !== null) return isObject(projectOverrides[modelKey]) && Object.hasOwn(projectOverrides[modelKey], "reserveTokens");
      return Object.hasOwn(project, "reserveTokens") ||
        !!(currentKey && isObject(projectOverrides[currentKey]) && Object.hasOwn(projectOverrides[currentKey], "reserveTokens"));
    };
    const contextWindowFor = (key: string | null): number | undefined => {
      if (!key) return undefined;
      if (key === currentKey) return ctx.model?.contextWindow;
      const slash = key.indexOf("/");
      return slash > 0 ? ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1))?.contextWindow : undefined;
    };
    const thresholdLabel = (key: string | null): string => {
      const reserve = reserveOf(compaction, key);
      const window = contextWindowFor(key);
      return `${window && window > reserve ? `after ${format(window - reserve)} · ` : ""}reserve ${format(reserve)}`;
    };
    const targets: Array<{ key: string | null; label: string }> = [
      { key: null, label: `Global default — ${thresholdLabel(null)}${isProjectOverride(null) ? " (project override active)" : ""}` },
      ...keys.map((key) => ({
        key,
        label: `${key === currentKey ? "Current · " : ""}${key} — ${thresholdLabel(key)}${isProjectOverride(key) ? " (project override active)" : ""}`,
      })),
    ];
    const selected = await ctx.ui.select("pi-vcc: auto-compaction limits", [
      ...targets.map((target) => target.label), "Cancel",
    ]);
    const target = targets.find((item) => item.label === selected);
    if (!target) return;

    const modelKey = target.key;
    const contextWindow = contextWindowFor(modelKey);
    const windowSize = contextWindow && contextWindow > 0 ? contextWindow : undefined;
    const reserve = reserveOf(compaction, modelKey);
    const after = windowSize === undefined ? undefined : windowSize - reserve;
    const setAfter = windowSize !== undefined ? `Compact after used tokens (now ${format(after!)} of ${format(windowSize)})` : undefined;
    const setReserve = `Headroom reserve (now ${format(reserve)} tokens)`;
    const hasOverride = modelKey !== null && isObject(overrides[modelKey]) &&
      Object.hasOwn(overrides[modelKey], "reserveTokens");
    const reset = hasOverride ? "Use inherited global default" : undefined;
    const options = [setAfter, setReserve, reset, "Back"].filter((s): s is string => !!s);
    const action = await ctx.ui.select(`Configure ${modelKey ?? "global default"}`, options);
    if (!action || action === "Back") return;

    let nextReserve: number | null;
    if (action === reset) {
      nextReserve = null;
    } else {
      const isAfter = action === setAfter;
      const raw = await ctx.ui.input(
        isAfter ? `Compact after how many used tokens? (window ${format(windowSize!)})` : "How many tokens of headroom should remain?",
        isAfter ? `${format(after!)} (or 200k)` : `${format(reserve)} (or 100k)`,
      );
      if (raw === undefined) return;
      if (!raw.trim()) {
        ctx.ui.notify("Compaction limit unchanged", "info");
        return;
      }
      const count = tokenCount(raw);
      const maxWindow = windowSize ?? (modelKey === null ? ctx.model?.contextWindow : undefined);
      if (count === undefined || count < 1 || (maxWindow !== undefined && count >= maxWindow)) {
        ctx.ui.notify(`Enter a positive token count${maxWindow ? ` below ${format(maxWindow)}` : ""} (e.g. 200k)`, "warning");
        return;
      }
      nextReserve = isAfter ? windowSize! - count : count;
    }

    if (nextReserve === reserve && action !== reset) {
      ctx.ui.notify("Compaction limit unchanged", "info");
      return;
    }
    await saveReserve(path, modelKey, nextReserve);
    ctx.ui.notify(isProjectOverride(modelKey)
      ? "Global setting saved, but a project-local override still takes precedence. Reloading Pi settings."
      : `Auto-compaction limit saved for ${modelKey ?? "global default"}; reloading Pi settings`,
    isProjectOverride(modelKey) ? "warning" : "info");
    saved = true;
  } catch (err) {
    ctx.ui.notify(`Cannot update auto-compaction settings: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  if (saved) {
    // The old extension context is invalid after reload; do not use ctx.ui then.
    try { await ctx.reload(); }
    catch (err) { throw new Error("Settings saved, but reload failed. Run /reload to apply them.", { cause: err }); }
  }
}
