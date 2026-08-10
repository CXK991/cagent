// Lightweight control-systems engine for Cagent plots (Bode/Nyquist/root locus/step).
// Pure JS — works on desktop and mobile without Python or external services.

export interface Complex { re: number; im: number; }

/** Polynomial coefficients, highest degree first: [a_n, ..., a_0]. */
export type Poly = number[];

export interface TransferFunction { num: Poly; den: Poly; }

// ---------- complex arithmetic ----------

export const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
export const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const cDiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im || 1e-300;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
export const cAbs = (a: Complex): number => Math.hypot(a.re, a.im);

// ---------- polynomial arithmetic ----------

export function polyTrim(p: Poly): Poly {
  let i = 0;
  while (i < p.length - 1 && Math.abs(p[i]) < 1e-12) i++;
  return p.slice(i);
}

export function polyAdd(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const ai = a.length - n + i, bi = b.length - n + i;
    out[i] = (ai >= 0 ? a[ai] : 0) + (bi >= 0 ? b[bi] : 0);
  }
  return polyTrim(out);
}

export function polySub(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const ai = a.length - n + i, bi = b.length - n + i;
    out[i] = (ai >= 0 ? a[ai] : 0) - (bi >= 0 ? b[bi] : 0);
  }
  return polyTrim(out);
}

export function polyScale(p: Poly, k: number): Poly { return p.map((c) => c * k); }

export function polyMul(a: Poly, b: Poly): Poly {
  if (a.length === 0 || b.length === 0) return [0];
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return polyTrim(out);
}

/** Horner evaluation of a polynomial at a complex point. */
export function polyEvalC(p: Poly, s: Complex): Complex {
  let acc: Complex = { re: 0, im: 0 };
  for (const c of p) acc = cAdd(cMul(acc, s), { re: c, im: 0 });
  return acc;
}

/** Unit-feedback closed loop T = G/(1+G): num stays, den becomes den+num. */
export function closedLoop(tf: TransferFunction): TransferFunction {
  return { num: tf.num, den: polyAdd(tf.den, tf.num) };
}

// ---------- transfer-function parser ----------
// Accepts things like: "10/(s(s+1))", "(s+2)/(s^2+2s+5)", "5*(s+2)/(s*(s+3))", "1".

interface Frac { num: Poly; den: Poly; }

function fracMul(a: Frac, b: Frac): Frac { return { num: polyMul(a.num, b.num), den: polyMul(a.den, b.den) }; }
function fracDiv(a: Frac, b: Frac): Frac { return { num: polyMul(a.num, b.den), den: polyMul(a.den, b.num) }; }
function fracAdd(a: Frac, b: Frac, sign: 1 | -1): Frac {
  return {
    num: polyAdd(polyMul(a.num, b.den), polyScale(polyMul(b.num, a.den), sign)),
    den: polyMul(a.den, b.den),
  };
}

const NUM_RE = /^\d+(\.\d+)?$/;

export function parseTF(input: string): TransferFunction {
  const src = input.trim().replace(/\s+/g, "");
  if (!src) throw new Error("Empty transfer function");
  let i = 0;
  const peek = (): string => src[i] ?? "";
  const startsAtom = (): boolean => {
    const c = peek();
    return c === "s" || c === "(" || (c >= "0" && c <= "9") || c === ".";
  };
  const parseExpr = (): Frac => {
    let acc = parseTerm();
    for (;;) {
      const c = peek();
      if (c === "+" || c === "-") {
        i++;
        const right = parseTerm();
        acc = fracAdd(acc, right, c === "+" ? 1 : -1);
      } else break;
    }
    return acc;
  };
  const parseTerm = (): Frac => {
    let acc = parseFactor();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; acc = fracMul(acc, parseFactor()); }
      else if (c === "/") { i++; acc = fracDiv(acc, parseFactor()); }
      else if (startsAtom()) { acc = fracMul(acc, parseFactor()); } // implicit *
      else break;
    }
    return acc;
  };
  const parseFactor = (): Frac => {
    const c = peek();
    let base: Frac;
    if (c === "(") {
      i++;
      base = parseExpr();
      if (peek() !== ")") throw new Error(`Expected ")" at ${i} in ${input}`);
      i++;
    } else if (c === "s") {
      i++;
      base = { num: [1, 0], den: [1] };
    } else if (c >= "0" && c <= "9" || c === ".") {
      let j = i;
      while (j < src.length && (src[j] >= "0" && src[j] <= "9" || src[j] === ".")) j++;
      const v = parseFloat(src.slice(i, j));
      i = j;
      base = { num: [v], den: [1] };
    } else {
      throw new Error(`Unexpected "${c}" at ${i} in ${input}`);
    }
    // exponent s^n
    if (peek() === "^") {
      i++;
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      const n = parseInt(src.slice(i, j), 10);
      i = j;
      const p = new Array(n + 1).fill(0);
      p[0] = 1;
      base = fracMul(base, { num: p, den: [1] });
    }
    return base;
  };
  const f = parseExpr();
  if (i < src.length) throw new Error(`Trailing "${src.slice(i)}" in ${input}`);
  return { num: polyTrim(f.num), den: polyTrim(f.den) };
}

// ---------- frequency response ----------

export function evalTF(tf: TransferFunction, s: Complex): Complex {
  const n = polyEvalC(tf.num, s);
  const d = polyEvalC(tf.den, s);
  return cDiv(n, d);
}

export interface BodePoint { w: number; db: number; phase: number; }

/** Log-spaced frequency sweep with magnitude (dB) and phase (deg). */
export function bodeData(tf: TransferFunction, wMin = 1e-3, wMax = 1e3, n = 140): BodePoint[] {
  const pts: BodePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const w = wMin * Math.pow(wMax / wMin, i / n);
    const g = evalTF(tf, { re: 0, im: w });
    const mag = Math.hypot(g.re, g.im);
    pts.push({
      w,
      db: 20 * Math.log10(Math.max(mag, 1e-12)),
      phase: (Math.atan2(g.im, g.re) * 180) / Math.PI,
    });
  }
  return pts;
}

export interface NyqPoint { re: number; im: number; w: number; }

/** Nyquist contour: positive frequencies plus their conjugate mirror. */
export function nyquistData(tf: TransferFunction, wMin = 1e-3, wMax = 1e3, n = 70): NyqPoint[] {
  const pos: NyqPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const w = wMin * Math.pow(wMax / wMin, i / n);
    const g = evalTF(tf, { re: 0, im: w });
    pos.push({ re: g.re, im: g.im, w });
  }
  const neg = pos.map((p) => ({ re: p.re, im: -p.im, w: -p.w })).reverse();
  return neg.concat(pos);
}

// ---------- roots & root locus ----------

/** Durand-Kerner simultaneous root finder. Optional warm-start guesses keep
 *  the trajectory continuous when sweeping K. */
export function polyRoots(coeffs: Poly, guess?: Complex[], maxIter = 300): Complex[] {
  const p = polyTrim(coeffs);
  const n = p.length - 1;
  if (n <= 0) return [];
  if (n === 1) return [{ re: -p[1] / p[0], im: 0 }];
  const x: Complex[] = guess && guess.length === n
    ? guess.slice()
    : Array.from({ length: n }, (_, k) => ({
        re: 0.4 * Math.cos((2 * Math.PI * k) / n),
        im: 0.9 * Math.sin((2 * Math.PI * k) / n),
      }));
  for (let it = 0; it < maxIter; it++) {
    const next: Complex[] = [];
    let maxDelta = 0;
    for (let k = 0; k < n; k++) {
      const num = polyEvalC(p, x[k]);
      let den: Complex = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j !== k) den = cMul(den, cSub(x[k], x[j]));
      }
      const delta = cDiv(num, den);
      next.push(cSub(x[k], delta));
      maxDelta = Math.max(maxDelta, Math.hypot(delta.re, delta.im));
    }
    for (let k = 0; k < n; k++) x[k] = next[k];
    if (maxDelta < 1e-10) break;
  }
  return x;
}

export interface RootLocusPoint { k: number; roots: Complex[]; }

/** Closed-loop poles of 1 + K*G(s) = 0 for K in [0, kMax]. */
export function rootLocusData(tf: TransferFunction, kMax = 100, steps = 120): RootLocusPoint[] {
  let init = polyRoots(tf.den);
  const out: RootLocusPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = (kMax * i) / steps;
    const poly = polyAdd(tf.den, polyScale(tf.num, k));
    init = polyRoots(poly, init, 60);
    out.push({ k, roots: init.slice().sort((a, b) => a.re - b.re || a.im - b.im) });
  }
  return out;
}

// ---------- step response (state space + RK4) ----------

export interface StepPoint { t: number; y: number; }

function makeStepData(tf: TransferFunction, tEnd: number, n = 600): StepPoint[] {
  const den = polyTrim(tf.den);
  const num = polyTrim(tf.num);
  const order = den.length - 1;
  if (order <= 0) {
    const gain = num.length > 0 ? num[0] / den[0] : 0;
    return Array.from({ length: n + 1 }, (_, i) => ({ t: (tEnd * i) / n, y: gain }));
  }
  // normalize: leading denominator coefficient = 1
  const lead = den[0];
  const a = den.map((c) => c / lead);
  // numerator coefficients for state-output mapping (lowest degree first)
  const nb = new Array(order).fill(0);
  const numNorm = num.map((c) => c / lead);
  for (let i = 0; i < order; i++) {
    const idx = numNorm.length - 1 - i;
    nb[i] = idx >= 0 ? numNorm[idx] : 0;
  }
  const dFeed = numNorm.length > order ? numNorm[0] : 0;
  // companion-form state matrix (order x order)
  const A: number[][] = [];
  for (let r = 0; r < order; r++) A.push(new Array(order).fill(0));
  for (let c = 0; c < order - 1; c++) A[c][c + 1] = 1;
  for (let c = 0; c < order; c++) A[order - 1][c] = -a[order - c];
  const B = new Array(order).fill(0);
  B[order - 1] = 1;
  const dt = tEnd / n;
  const x = new Array(order).fill(0);
  const out: StepPoint[] = [{ t: 0, y: dFeed }];
  const deriv = (xs: number[]): number[] => {
    const dx = new Array(order).fill(0);
    for (let r = 0; r < order; r++) {
      let v = B[r];
      for (let c = 0; c < order; c++) v += A[r][c] * xs[c];
      dx[r] = v;
    }
    return dx;
  };
  for (let i = 1; i <= n; i++) {
    const k1 = deriv(x);
    const k2 = deriv(x.map((v, j) => v + 0.5 * dt * k1[j]));
    const k3 = deriv(x.map((v, j) => v + 0.5 * dt * k2[j]));
    const k4 = deriv(x.map((v, j) => v + dt * k3[j]));
    for (let j = 0; j < order; j++) x[j] += (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
    let y = dFeed;
    for (let j = 0; j < order; j++) y += nb[j] * x[j];
    out.push({ t: i * dt, y });
  }
  return out;
}

/** Auto-pick a sensible time horizon from the poles. */
function suggestTEnd(tf: TransferFunction): number {
  const roots = polyRoots(tf.den);
  let minAbs = Infinity;
  for (const r of roots) {
    if (r.re < -1e-9) minAbs = Math.min(minAbs, -r.re);
  }
  if (!isFinite(minAbs)) return 10;
  return Math.min(100, Math.max(2, (5 / minAbs) * 2));
}

export function stepData(tf: TransferFunction, tEnd?: number, n = 600): StepPoint[] {
  return makeStepData(tf, tEnd && tEnd > 0 ? tEnd : suggestTEnd(tf), n);
}

