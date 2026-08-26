/**
 * Fail closed for the TFOS remediation program until its stated acceptance
 * evaluations have both been checked and tied to durable execution evidence.
 *
 * This is deliberately scoped by the immutable program markers in the issue
 * description, rather than changing close behavior for unrelated companies.
 */
const TFOS_MARKER = /\bTFOS-ALIGN\b|\bremediation-program-2026-08\b/i;
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/gm;
const EVIDENCE_POINTER = /https?:\/\/\S+|\bheartbeat_runs?\b[^\n]{0,80}\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b(?:CI run|command receipt)\b/i;

export type TfosAcceptanceClosureCheck =
  | { applies: false; incomplete: [] }
  | { applies: true; incomplete: string[] };

export function checkTfosAcceptanceClosure(description: string | null | undefined): TfosAcceptanceClosureCheck {
  if (!description || !TFOS_MARKER.test(description)) return { applies: false, incomplete: [] };

  const checks = Array.from(description.matchAll(CHECKBOX));
  if (checks.length === 0) {
    return { applies: true, incomplete: ["issue has no acceptance-eval checklist"] };
  }

  const incomplete = checks.flatMap((match, index) => {
    const checked = match[1]?.toLowerCase() === "x";
    const item = match[2]?.trim() || "unnamed acceptance eval";
    const evidenceEnd = checks[index + 1]?.index ?? description.length;
    const evidenceBlock = description.slice(match.index ?? 0, evidenceEnd);
    if (!checked) return [`unchecked: ${item}`];
    if (!EVIDENCE_POINTER.test(evidenceBlock)) return [`missing evidence pointer: ${item}`];
    return [];
  });

  return { applies: true, incomplete };
}
