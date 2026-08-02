// Minimal line-based diff (LCS) used for consent previews.
// No dependencies; adequate for previewing note-sized edits.

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
}

const MAX_DIFF_LINES = 800; // per side; larger files skip the preview

/**
 * Compute a compact unified-style line diff between two texts.
 * Returns null when the input is too large for an interactive preview.
 */
export function computeLineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  // LCS table
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: "del", text: a[i] });
      i++;
    } else {
      raw.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) raw.push({ type: "del", text: a[i++] });
  while (j < m) raw.push({ type: "add", text: b[j++] });

  return collapseContext(raw, 3);
}

/** Keep only `ctx` lines of context around each change hunk. */
function collapseContext(lines: DiffLine[], ctx: number): DiffLine[] {
  const changed = lines.map((l, idx) => (l.type !== "ctx" ? idx : -1)).filter((idx) => idx >= 0);
  if (changed.length === 0) return [];
  const keep = new Set<number>();
  for (const idx of changed) {
    for (let k = Math.max(0, idx - ctx); k <= Math.min(lines.length - 1, idx + ctx); k++) keep.add(k);
  }
  const out: DiffLine[] = [];
  let skipped = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep.has(idx)) {
      if (skipped > 0) out.push({ type: "ctx", text: `… (${skipped} unchanged lines)` });
      skipped = 0;
      out.push(lines[idx]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push({ type: "ctx", text: `… (${skipped} unchanged lines)` });
  return out;
}
