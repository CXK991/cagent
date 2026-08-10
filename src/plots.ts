// SVG chart renderers for Cagent: Bode, Nyquist, root locus, step response.
// Pure string generation — no canvas needed, works on mobile.

import { BodePoint, Complex, NyqPoint, RootLocusPoint, StepPoint, TransferFunction, polyRoots } from "./control";

const FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function svgHeader(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}">`;
}

function polyline(pts: Array<[number, number]>, stroke: string, width = 2): string {
  if (pts.length < 2) return "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function niceCeil(v: number, step: number): number { return Math.ceil(v / step) * step; }
function niceFloor(v: number, step: number): number { return Math.floor(v / step) * step; }

/** Generic axis + grid drawer. x/y are data->pixel mappers. */
function gridAndAxes(
  xLines: Array<{ v: number; label?: string }>,
  yLines: Array<{ v: number; label?: string }>,
  xMap: (v: number) => number,
  yMap: (v: number) => number,
  w: number,
  h: number,
  opts: { xLabel?: string; yLabel?: string; padL?: number; padR?: number; padT?: number; padB?: number }
): string {
  const padL = opts.padL ?? 46, padR = opts.padR ?? 14, padT = opts.padT ?? 12, padB = opts.padB ?? 30;
  let s = `<rect x="${padL}" y="${padT}" width="${w - padL - padR}" height="${h - padT - padB}" fill="none" stroke="#9ca3af" stroke-opacity="0.35"/>`;
  for (const l of xLines) {
    const x = xMap(l.v);
    s += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${h - padB}" stroke="#9ca3af" stroke-opacity="0.15" stroke-dasharray="2,3"/>`;
    if (l.label !== undefined) s += `<text x="${x}" y="${h - padB + 14}" font-size="10" text-anchor="middle" fill="#6b7280" fill-opacity="0.75">${esc(l.label)}</text>`;
  }
  for (const l of yLines) {
    const y = yMap(l.v);
    s += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#9ca3af" stroke-opacity="0.15" stroke-dasharray="2,3"/>`;
    if (l.label !== undefined) s += `<text x="${padL - 6}" y="${y + 3}" font-size="10" text-anchor="end" fill="#6b7280" fill-opacity="0.75">${esc(l.label)}</text>`;
  }
  if (opts.xLabel) s += `<text x="${padL + (w - padL - padR) / 2}" y="${h - 6}" font-size="11" text-anchor="middle" fill="#6b7280" fill-opacity="0.9">${esc(opts.xLabel)}</text>`;
  if (opts.yLabel) s += `<text x="12" y="${padT + (h - padT - padB) / 2}" font-size="11" text-anchor="middle" fill="#6b7280" fill-opacity="0.9" transform="rotate(-90 12 ${padT + (h - padT - padB) / 2})">${esc(opts.yLabel)}</text>`;
  return s;
}

// ---------- Bode diagram (two stacked panels) ----------

export function svgBode(pts: BodePoint[], title = "Bode 图"): string {
  const W = 760, H = 520, PH = 240;
  const lo = Math.log10(pts[0].w), hi = Math.log10(pts[pts.length - 1].w);
  const dbVals = pts.map((p) => p.db);
  const phVals = pts.map((p) => p.phase);
  const dbMin = niceFloor(Math.min(...dbVals) - 6, 20);
  const dbMax = niceCeil(Math.max(...dbVals) + 6, 20);
  const phMin = niceFloor(Math.min(...phVals) - 10, 45);
  const phMax = niceCeil(Math.max(...phVals) + 10, 45);
  const xMap = (w: number) => 46 + ((Math.log10(w) - lo) / (hi - lo)) * (W - 60);
  const yDb = (db: number) => 12 + ((dbMax - db) / (dbMax - dbMin)) * (PH - 42);
  const yPh = (ph: number) => 292 + ((phMax - ph) / (phMax - phMin)) * (PH - 42);
  const xLines: Array<{ v: number; label?: string }> = [];
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) xLines.push({ v: Math.pow(10, e), label: `10^${e}` });
  const dbLines: Array<{ v: number; label?: string }> = [];
  for (let v = dbMin; v <= dbMax; v += 20) dbLines.push({ v, label: String(v) });
  const phLines: Array<{ v: number; label?: string }> = [];
  for (let v = phMin; v <= phMax; v += 90) phLines.push({ v, label: String(v) });
  let s = svgHeader(W, H);
  s += `<text x="${W / 2}" y="22" font-size="14" font-weight="600" text-anchor="middle" fill="#6b7280">${esc(title)}</text>`;
  s += gridAndAxes(xLines, dbLines, xMap, yDb, W, PH, { xLabel: "频率 (rad/s)", yLabel: "幅值 (dB)" });
  s += gridAndAxes(xLines, phLines, xMap, yPh, W, H, { xLabel: "频率 (rad/s)", yLabel: "相位 (deg)" });
  s += polyline(pts.map((p) => [xMap(p.w), yDb(p.db)] as [number, number]), "#3b82f6");
  s += polyline(pts.map((p) => [xMap(p.w), yPh(p.phase)] as [number, number]), "#3b82f6");
  s += "</svg>";
  return s;
}

// ---------- Nyquist plot ----------

export function svgNyquist(pts: NyqPoint[], title = "Nyquist 图"): string {
  const W = 560, H = 520;
  const reVals = pts.map((p) => p.re);
  const imVals = pts.map((p) => p.im);
  const fullSpan = Math.max(Math.abs(Math.min(...reVals)), Math.abs(Math.max(...reVals)), Math.abs(Math.min(...imVals)), Math.abs(Math.max(...imVals))) || 1;
  // Systems with integrators (pole at s=0) have |Im| -> infinity as w -> 0;
  // a max-based span would crush the real axis into a sub-pixel vertical line.
  // Base the scale on the median extent instead and let the tail run off-canvas
  // (clipped), like textbook Nyquist sketches.
  const absRe = reVals.map(Math.abs).sort((a, b) => a - b);
  const absIm = imVals.map(Math.abs).sort((a, b) => a - b);
  const medIdx = Math.floor(absRe.length / 2);
  const core = Math.max(absRe[medIdx] || 0, absIm[medIdx] || 0) * 2.2 || 1;
  const beyond = pts.filter((pt) => Math.hypot(pt.re, pt.im) > core).length / pts.length;
  // A real tail: many points far outside the median core (integrator at s=0).
  const span = (beyond > 0.25 && fullSpan > core * 4 ? core : fullSpan) * 1.15;
  const cx = W / 2, cy = H / 2 - 10, scale = (H / 2 - 60) / span;
  const X = (re: number) => cx + re * scale;
  const Y = (im: number) => cy - im * scale;
  let s = svgHeader(W, H);
  s += `<text x="${W / 2}" y="22" font-size="14" font-weight="600" text-anchor="middle" fill="#6b7280">${esc(title)}</text>`;
  s += `<clipPath id="nyqClip"><rect x="20" y="30" width="${W - 40}" height="${H - 60}"/></clipPath>`;
  s += `<g clip-path="url(#nyqClip)">`;
  // axes
  s += `<line x1="20" y1="${cy}" x2="${W - 20}" y2="${cy}" stroke="#9ca3af" stroke-opacity="0.5"/>`;
  s += `<line x1="${cx}" y1="30" x2="${cx}" y2="${H - 20}" stroke="#9ca3af" stroke-opacity="0.5"/>`;
  s += `<text x="${W - 18}" y="${cy - 6}" font-size="11" fill="#6b7280" fill-opacity="0.8">Re</text>`;
  s += `<text x="${cx + 6}" y="38" font-size="11" fill="#6b7280" fill-opacity="0.8">Im</text>`;
  // unit circle (dashed) when it fits
  if (span >= 1.05) s += `<circle cx="${cx}" cy="${cy}" r="${scale}" fill="none" stroke="#9ca3af" stroke-opacity="0.25" stroke-dasharray="3,3"/>`;
  // grid ticks
  const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
  for (let v = step; v < span; v += step) {
    s += `<line x1="${X(v)}" y1="${cy - 4}" x2="${X(v)}" y2="${cy + 4}" stroke="#9ca3af" stroke-opacity="0.4"/>`;
    s += `<line x1="${X(-v)}" y1="${cy - 4}" x2="${X(-v)}" y2="${cy + 4}" stroke="#9ca3af" stroke-opacity="0.4"/>`;
    s += `<line x1="${cx - 4}" y1="${Y(v)}" x2="${cx + 4}" y2="${Y(v)}" stroke="#9ca3af" stroke-opacity="0.4"/>`;
    s += `<line x1="${cx - 4}" y1="${Y(-v)}" x2="${cx + 4}" y2="${Y(-v)}" stroke="#9ca3af" stroke-opacity="0.4"/>`;
  }
  // curve: positive frequencies (solid), negative mirror (dashed)
  const mid = Math.floor(pts.length / 2);
  const negPts = pts.slice(0, mid + 1).map((p) => [X(p.re), Y(p.im)] as [number, number]);
  const posPts = pts.slice(mid).map((p) => [X(p.re), Y(p.im)] as [number, number]);
  s += polyline(negPts, "#9ca3af", 1.4);
  s += polyline(posPts, "#3b82f6", 2.2);
  // start + direction arrow
  const start = posPts[0];
  const arrow = posPts[Math.min(8, posPts.length - 1)];
  s += `<circle cx="${start[0]}" cy="${start[1]}" r="3.5" fill="#3b82f6"/>`;
  const ang = Math.atan2(arrow[1] - start[1], arrow[0] - start[0]);
  s += `<path d="M${arrow[0]},${arrow[1]} l${(8 * Math.cos(ang + 2.6)).toFixed(1)},${(8 * Math.sin(ang + 2.6)).toFixed(1)} M${arrow[0]},${arrow[1]} l${(8 * Math.cos(ang - 2.6)).toFixed(1)},${(8 * Math.sin(ang - 2.6)).toFixed(1)}" stroke="#3b82f6" stroke-width="1.6" fill="none"/>`;
  s += `</g>`;
  s += `<text x="${cx}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#6b7280" fill-opacity="0.7">ω: 0 → ∞（实线，右侧镜像为负频率）</text>`;
  s += "</svg>";
  return s;
}

// ---------- Root locus ----------

export function svgRootLocus(data: RootLocusPoint[], tf: TransferFunction, title = "根轨迹图"): string {
  const W = 560, H = 520;
  const all: Complex[] = [];
  for (const p of data) all.push(...p.roots);
  const zeros = polyRoots(tf.num);
  const reAll = [...all.map((r) => r.re), ...zeros.map((z) => z.re)];
  const imAll = [...all.map((r) => r.im), ...zeros.map((z) => z.im)];
  const spanX = Math.max(1, Math.max(...reAll.map((v) => Math.abs(v)))) * 1.2;
  const spanY = Math.max(1, Math.max(...imAll.map((v) => Math.abs(v)))) * 1.2;
  const span = Math.max(spanX, spanY);
  const cx = W / 2, cy = H / 2 - 10, scale = (H / 2 - 60) / span;
  const X = (re: number) => cx + re * scale;
  const Y = (im: number) => cy - im * scale;
  let s = svgHeader(W, H);
  s += `<text x="${W / 2}" y="22" font-size="14" font-weight="600" text-anchor="middle" fill="#6b7280">${esc(title)}</text>`;
  s += `<line x1="20" y1="${cy}" x2="${W - 20}" y2="${cy}" stroke="#9ca3af" stroke-opacity="0.5"/>`;
  s += `<line x1="${cx}" y1="30" x2="${cx}" y2="${H - 20}" stroke="#9ca3af" stroke-opacity="0.5"/>`;
  s += `<text x="${W - 18}" y="${cy - 6}" font-size="11" fill="#6b7280" fill-opacity="0.8">σ</text>`;
  s += `<text x="${cx + 6}" y="38" font-size="11" fill="#6b7280" fill-opacity="0.8">jω</text>`;
  const nBranches = data[0]?.roots.length ?? 0;
  for (let b = 0; b < nBranches; b++) {
    const pts = data.map((p) => [X(p.roots[b].re), Y(p.roots[b].im)] as [number, number]);
    s += polyline(pts, "#3b82f6", 1.8);
  }
  // poles (K=0) as x, zeros as o
  for (const z of zeros) {
    s += `<circle cx="${X(z.re)}" cy="${Y(z.im)}" r="5" fill="none" stroke="#9ca3af" stroke-width="1.8"/>`;
  }
  for (const r of data[0]?.roots ?? []) {
    s += `<line x1="${X(r.re) - 5}" y1="${Y(r.im) - 5}" x2="${X(r.re) + 5}" y2="${Y(r.im) + 5}" stroke="#9ca3af" stroke-width="1.8"/>`;
    s += `<line x1="${X(r.re) - 5}" y1="${Y(r.im) + 5}" x2="${X(r.re) + 5}" y2="${Y(r.im) - 5}" stroke="#9ca3af" stroke-width="1.8"/>`;
  }
  s += `<text x="${cx}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#6b7280" fill-opacity="0.7">× 极点（K=0）　○ 零点　曲线为 K: 0 → ${data[data.length - 1]?.k ?? ""}</text>`;
  s += "</svg>";
  return s;
}

// ---------- Step response ----------

export function svgStep(pts: StepPoint[], title = "单位阶跃响应"): string {
  const W = 760, H = 420;
  const tMax = pts[pts.length - 1].t;
  const ys = pts.map((p) => p.y);
  const yMax = Math.max(1.1, niceCeil(Math.max(...ys) * 1.08, 0.2));
  const yMin = Math.min(0, niceFloor(Math.min(...ys) * 1.08 - 0.05, 0.2));
  const xMap = (t: number) => 46 + (t / tMax) * (W - 60);
  const yMap = (y: number) => 12 + ((yMax - y) / (yMax - yMin)) * (H - 52);
  const xLines: Array<{ v: number; label?: string }> = [];
  const xStep = tMax <= 2 ? 0.5 : tMax <= 5 ? 1 : tMax <= 20 ? 5 : 20;
  for (let v = 0; v <= tMax + 1e-9; v += xStep) xLines.push({ v, label: String(v) });
  const yLines: Array<{ v: number; label?: string }> = [];
  for (let v = yMin; v <= yMax + 1e-9; v += 0.2) yLines.push({ v, label: v.toFixed(1) });
  let s = svgHeader(W, H);
  s += `<text x="${W / 2}" y="22" font-size="14" font-weight="600" text-anchor="middle" fill="#6b7280">${esc(title)}</text>`;
  s += gridAndAxes(xLines, yLines, xMap, yMap, W, H, { xLabel: "时间 (s)", yLabel: "幅值" });
  // final value reference (unit step → 1)
  s += `<line x1="${xMap(0)}" y1="${yMap(1)}" x2="${xMap(tMax)}" y2="${yMap(1)}" stroke="#9ca3af" stroke-opacity="0.35" stroke-dasharray="4,4"/>`;
  s += polyline(pts.map((p) => [xMap(p.t), yMap(p.y)] as [number, number]), "#3b82f6");
  s += "</svg>";
  return s;
}

