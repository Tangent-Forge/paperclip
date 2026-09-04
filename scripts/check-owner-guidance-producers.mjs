#!/usr/bin/env node
/**
 * check-owner-guidance-producers.mjs
 *
 * Regression guard for Owner Decision Projection v1:
 * first-party human-confirmation producers must teach structured
 * payload.ownerGuidance and must not ship copy-pasteable bare
 * request_confirmation / ask_user_questions / request_checkbox_confirmation
 * JSON create examples.
 *
 * Exit 0 when clean; exit 1 with defect list otherwise.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Paths that are live/first-party producers or copy-paste create surfaces. */
const SCAN_GLOBS_ROOTS = [
  "server/src/onboarding-assets",
  "server/src/built-ins/agents",
  "skills/paperclip",
  "skills-releases/paperclip/v7-roster",
  "packages/skills-catalog/catalog",
  "docs/api",
  "docs/guides/agent-developer",
  "doc/CLI.md",
  "packages/adapters/openclaw-gateway/src/server/execute.ts",
];

/** Historical / archived skill releases — intentionally not live producers. */
const ALLOWLIST_PREFIXES = [
  "skills-releases/paperclip/v0/",
];

const HUMAN_KINDS = [
  "request_confirmation",
  "ask_user_questions",
  "request_checkbox_confirmation",
];

const REQUIRED_GUIDANCE_KEYS = [
  "recommendedDisposition",
  "rationale",
  "whyHuman",
  "deferConsequence",
  "blastRadius",
  "decisionClass",
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(md|ts|tsx|mjs|js|json|yml|yaml)$/.test(name)) out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = new Set();
  for (const root of SCAN_GLOBS_ROOTS) {
    const abs = join(ROOT, root);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isFile()) files.add(abs);
    else walk(abs).forEach((f) => files.add(f));
  }
  return [...files];
}

function isAllowlisted(rel) {
  return ALLOWLIST_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * Detect JSON/object-looking create examples that name a human kind but omit
 * ownerGuidance in the same payload block (~1.2k window).
 */
function findBareJsonExamples(content, rel) {
  const defects = [];
  for (const kind of HUMAN_KINDS) {
    const kindRe = new RegExp(
      `["']kind["']\\s*:\\s*["']${kind}["']`,
      "g",
    );
    let m;
    while ((m = kindRe.exec(content)) !== null) {
      const start = m.index;
      const window = content.slice(start, start + 1400);
      // Not a create payload if it's only a kind enum / table row without payload
      if (!/["']payload["']\s*:/.test(window) && !/payload\.ownerGuidance|ownerGuidance/.test(window)) {
        // CLI one-liners and short sh examples may embed kind+payload without nested payload key spelling
        if (!/prompt["']?\s*:/.test(window) && !/--payload-json/.test(content.slice(Math.max(0, start - 80), start + 200))) {
          continue;
        }
      }
      const hasGuidance =
        /ownerGuidance/.test(window) ||
        REQUIRED_GUIDANCE_KEYS.every((k) => window.includes(k));
      if (!hasGuidance) {
        const line = content.slice(0, start).split(/\n/).length;
        defects.push({
          file: rel,
          line,
          kind,
          code: "bare_create_example",
          message: `Copy-pasteable ${kind} example lacks ownerGuidance in the nearby payload window`,
        });
      }
    }
  }
  return defects;
}

/**
 * Instruction files that teach creating human confirmations must also teach
 * the ownerGuidance contract (not only name the kind).
 */
function findInstructionGaps(content, rel) {
  const defects = [];
  if (!/\.md$/.test(rel) && !/AGENTS\.md$/.test(rel) && !/HEARTBEAT\.md$/.test(rel) && !/SKILL\.md$/.test(rel)) {
    return defects;
  }
  const teachesCreate =
    /create\s+`?request_confirmation`?/i.test(content) ||
    /kind:\s*["']?request_confirmation/i.test(content) ||
    /POST\s+\/api\/issues\/\{?issueId\}?\/interactions/i.test(content);
  const mentionsHumanKind = HUMAN_KINDS.some((k) => content.includes(k));
  if (!teachesCreate || !mentionsHumanKind) return defects;

  const hasContract =
    content.includes("ownerGuidance") &&
    REQUIRED_GUIDANCE_KEYS.filter((k) => content.includes(k)).length >= 4;

  if (!hasContract) {
    defects.push({
      file: rel,
      line: 1,
      kind: "instruction",
      code: "missing_owner_guidance_contract",
      message:
        "Instruction/template teaches human confirmation create but does not teach structured ownerGuidance fields",
    });
  }

  // Soft anti-escalation mentions for core agent templates
  if (/onboarding-assets|built-ins\/agents\/reflection-coach|skills\/paperclip\/SKILL\.md|skills-releases\/paperclip\/v7-roster\/SKILL\.md/.test(rel)) {
    const anti =
      /agent-ops|agent ops|owner_terminal|informational|board-seat|do not escalate/i.test(
        content,
      );
    if (!anti && content.includes("request_confirmation")) {
      defects.push({
        file: rel,
        line: 1,
        kind: "instruction",
        code: "missing_anti_escalation",
        message:
          "Core producer should mention anti-escalation (agent-ops / owner_terminal / board-seat preference)",
      });
    }
  }
  return defects;
}

function main() {
  const files = collectFiles();
  const defects = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    if (isAllowlisted(rel)) continue;
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!HUMAN_KINDS.some((k) => content.includes(k))) continue;
    defects.push(...findBareJsonExamples(content, rel));
    defects.push(...findInstructionGaps(content, rel));
  }

  // Dedup by file+code+kind
  const seen = new Set();
  const unique = [];
  for (const d of defects) {
    const key = `${d.file}|${d.code}|${d.kind}|${d.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }

  if (unique.length === 0) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          scannedFiles: files.length,
          defects: [],
          message: "No bare first-party human-confirmation producer templates found",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        scannedFiles: files.length,
        defectCount: unique.length,
        defects: unique,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { collectFiles, findBareJsonExamples, findInstructionGaps };
