import type { NormalizedBlock } from "../types";
import { clip } from "../core/content";

// A compacted goal is a quotation of a user instruction, not an inferred task
// state. Never promote assistant text, tool output or extension notifications.
const MAX_QUOTE_CHARS = 320;
const DIRECTION_RE = /^(?:(?:now|please|instead|actually|next|new task|change of plan|switch to|pivot to|stop .* and)\s*[,.: -]*\s*)?(?:fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up|evaluate|review|analy[sz]e|plan|research|find|prepare)\b/i;
const EXPLICIT_DIRECTION_RE = /\b(?:your task is to|the task is to|now i want|new research (?:task|direction)|change of plan|switch to|instead of|focus on|let me propose a new idea|actually,? instead)\b/i;
const QUESTION_RE = /^what if\b/i;
const NON_DIRECTION_RE = /^(?:ok(?:ay)?|yes|no|sure|continue|go ahead|do it|proceed|keep (?:going|working)|check (?:on )?it|check (?:the )?status|review your original brief|what(?:'s| is) (?:the )?(?:status|progress)|why (?:aren't|are not) you running|thanks|thx)\b/i;
const APPROVAL_RE = /^(?:go ahead|do it|proceed|approved|yes[, .]|i approve)\b/i;
const MANDATE_HEADING_RE = /^(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)]?\s+)?(?:scientific |research )?(?:mandate|objective|purpose)(?:\s*[:\-].*)?$/i;
const METADATA_RE = /^(?:#{1,6}\s*)?(?:handoff\b|date\s*:|repo\s*:|project\s*:|repository\s*:|primary repository\s*:|execution repositories\s*:|audience\s*:|status\s*:)/i;
const SECTION_RE = /^(?:#{1,6}\s*|\d+[.)]\s+)|^(?:research|review)\s+(?:question|status|summary|background|notes|results|plan|scope|overview|context)\s*:?$/i;

const sourceRef = (block: NormalizedBlock): string =>
  block.sourceIndex === undefined ? "" : ` (#${block.sourceIndex})`;

const quote = (text: string): string => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.findIndex((line) => MANDATE_HEADING_RE.test(line));
  // In a pasted research brief the mandate is generally below a named heading;
  // dates, paths and repo names appearing before it are not the objective.
  const taskLine = lines.slice(0, 30).find((line) =>
    !SECTION_RE.test(line) && !METADATA_RE.test(line) &&
    (DIRECTION_RE.test(line) || QUESTION_RE.test(line) || EXPLICIT_DIRECTION_RE.test(line)));
  const substantiveLine = lines.find((line) =>
    !METADATA_RE.test(line) && !SECTION_RE.test(line));
  const inlineMandate = heading >= 0 ? lines[heading].match(/^.*?\b(?:mandate|objective|purpose)\s*[:\-]\s*(.+)$/i)?.[1] : undefined;
  const candidate = heading >= 0 ? inlineMandate ?? lines[heading + 1] : taskLine ?? substantiveLine ?? lines[0];
  return clip(candidate ?? "", MAX_QUOTE_CHARS).trim();
};

const directionQuote = (text: string): string => {
  // Preserve the question itself when an instruction begins with a long preface.
  const question = text.search(/\bwhat if\b/i);
  return quote(question >= 0 ? text.slice(question) : text);
};

const isDirection = (text: string): boolean => {
  const lead = text.trim().slice(0, 500);
  if (NON_DIRECTION_RE.test(lead)) return false;
  return DIRECTION_RE.test(lead) || EXPLICIT_DIRECTION_RE.test(lead) || QUESTION_RE.test(lead);
};

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const user = blocks.filter((block): block is Extract<NormalizedBlock, { kind: "user" }> =>
    block.kind === "user" && quote(block.text).length > 5);
  if (user.length === 0) return [];

  const original = user[0];
  const later = user.slice(1).filter((block) => isDirection(block.text));
  const latest = later.at(-1);

  const result: string[] = [];
  if (latest && latest.text.trim() !== original.text.trim()) {
    const proposed = /\blet me propose a new idea\b/i.test(latest.text.slice(0, 500)) || QUESTION_RE.test(latest.text.trim());
    result.push(`${proposed ? "Latest user proposal" : "Latest substantive user direction"}${sourceRef(latest)}: ${directionQuote(latest.text)}`);
    if (proposed) {
      const followUp = user.slice(user.indexOf(latest) + 1).find((block) => APPROVAL_RE.test(block.text.trim()));
      if (followUp) result.push(`Subsequent user response${sourceRef(followUp)}: ${quote(followUp.text)}`);
    }
    result.push(`Earlier user request${sourceRef(original)} (not necessarily superseded): ${quote(original.text)}`);
  } else {
    result.push(`Original user request${sourceRef(original)}: ${quote(original.text)}`);
  }
  return result;
};
