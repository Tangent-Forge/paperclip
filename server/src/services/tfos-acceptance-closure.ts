const CHECKBOX_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/gm;
const MARKDOWN_LINK = /\[[^\]]+\]\([^\s)]+\)/;

export type TfosAcceptanceClosureResult =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Enforces the TFOS-ALIGN route gate at the only authoritative close path.
 * Every checkbox is an acceptance evaluation and must be checked with a
 * concrete, linked receipt on the same item before the issue can be closed.
 */
export function checkTfosAcceptanceClosure(description: string | null | undefined): TfosAcceptanceClosureResult {
  const items = [...(description ?? "").matchAll(CHECKBOX_ITEM)].map((match) => ({
    checked: match[1]?.toLowerCase() === "x",
    body: match[2] ?? "",
  }));

  if (items.length === 0) {
    return {
      allowed: false,
      message: "TFOS-ALIGN issues require an acceptance-evaluation checklist before they can be marked done",
    };
  }

  const incomplete = items.findIndex((item) => !item.checked || !MARKDOWN_LINK.test(item.body));
  if (incomplete >= 0) {
    return {
      allowed: false,
      message: `TFOS-ALIGN acceptance evaluation ${incomplete + 1} must be checked and include a linked evidence receipt before closing`,
    };
  }

  return { allowed: true };
}

export function isTfosAlignGoal(goal: { title?: string | null } | null | undefined) {
  return goal?.title?.trim().toUpperCase() === "TFOS-ALIGN";
}
