// Lightweight image editor for chat attachments: crop, rotate and annotate.
// Pure canvas + pointer events (no dependencies), so it works with touch on
// phones and with a mouse on desktop. Used for two flows:
//   1) edit an image before sending it;
//   2) re-edit an image already sent, then send the result as a new message.

import { App, Modal, setIcon } from "obsidian";
import { t, type Key } from "./i18n";
import type AgentPlugin from "./main";

/** Longest side of the exported image (mirrors the chat upload pipeline). */
const MAX_SIDE = 1280;
/** JPEG quality for the exported image (mirrors the chat upload pipeline). */
const JPEG_QUALITY = 0.85;
/** Undo depth. */
const MAX_HISTORY = 30;
/** Ignore crop drags smaller than this (in image px). */
const MIN_CROP = 12;

interface Point { x: number; y: number }
/** One freehand stroke, in rotated-image coordinates. */
interface Stroke { color: string; width: number; points: Point[] }
/** A rectangle in rotated-image coordinates. */
interface Rect { x: number; y: number; w: number; h: number }
interface Snapshot { rotation: number; crop: Rect | null; strokes: Stroke[] }

/** Pen colours: red first — circling "this question" is the main use case. */
const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0091ff", "#111111"];
/** Pen widths in image px. */
const WIDTHS = [3, 6, 12];

export interface ImageEditorOptions {
  /** Base64 JPEG without the data: prefix. */
  image: string;
  /** Called with the edited base64 image when the user taps Done. */
  onSave: (data: string) => void;
}

export class ImageEditorModal extends Modal {
  private base?: HTMLCanvasElement;
  /** Cache of the base image rotated into the current orientation. */
  private rotated?: HTMLCanvasElement;
  private rotatedKey = "";
  private display!: HTMLCanvasElement;
  private stageEl!: HTMLElement;

  /** Quarter turns clockwise (0–3). */
  private rotation = 0;
  /** Crop window, in rotated-image coordinates. `null` = whole image. */
  private crop: Rect | null = null;
  private strokes: Stroke[] = [];
  private history: Snapshot[] = [];

  private tool: "crop" | "draw" = "crop";
  private color = COLORS[0];
  private width = WIDTHS[1];

  /** Display pixels per image pixel. */
  private scale = 1;
  private dragAnchor: Point | null = null; // crop drag start (view coords)
  private dragRect: Rect | null = null;    // crop marquee (view coords)
  private drawing: Stroke | null = null;

  private modified = false;
  private downscaled = false;
  private resizeHandler = (): void => this.redraw();

  constructor(app: App, private plugin: AgentPlugin, private opts: ImageEditorOptions) {
    super(app);
  }

  private tr(key: Key): string {
    return t(this.plugin.settings.language, key);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("cagent-img-editor");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { cls: "cagent-img-editor-title", text: this.tr("imageEditorTitle") });

    const stage = contentEl.createDiv({ cls: "cagent-img-editor-stage" });
    this.stageEl = stage;
    this.display = stage.createEl("canvas", { cls: "cagent-img-editor-canvas" });
    this.bindPointer();

    // The image decodes asynchronously; build the canvas pipeline when ready.
    let img: HTMLImageElement;
    try {
      img = await this.loadImage();
    } catch {
      stage.createDiv({ cls: "cagent-img-editor-error", text: this.tr("imageEditorLoadFailed") });
      return;
    }
    this.buildBase(img);
    this.renderToolbar(contentEl);
    this.renderActions(contentEl);

    window.addEventListener("resize", this.resizeHandler);
    this.redraw();
  }

  onClose(): void {
    window.removeEventListener("resize", this.resizeHandler);
    this.contentEl.empty();
  }

  // ---------- Loading ----------

  private loadImage(): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = `data:image/jpeg;base64,${this.opts.image}`;
    });
  }

  /** Downscale the source once; every later step works on this canvas. */
  private buildBase(img: HTMLImageElement): void {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const longest = Math.max(w, h);
    if (longest > MAX_SIDE) {
      const k = MAX_SIDE / longest;
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
      this.downscaled = true;
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
    }
    this.base = c;
  }

  // ---------- Geometry ----------

  /** Size of the image in its current orientation. */
  private rotatedSize(): { w: number; h: number } {
    const b = this.base;
    if (!b) return { w: 1, h: 1 };
    return this.rotation % 2 === 0 ? { w: b.width, h: b.height } : { w: b.height, h: b.width };
  }

  /** Visible window: the crop, or the whole rotated image. */
  private viewRect(): Rect {
    if (this.crop) return this.crop;
    const { w, h } = this.rotatedSize();
    return { x: 0, y: 0, w, h };
  }

  private getRotated(): HTMLCanvasElement {
    const key = String(this.rotation);
    if (this.rotated && this.rotatedKey === key) return this.rotated;
    const b = this.base!;
    const { w, h } = this.rotatedSize();
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.translate(w / 2, h / 2);
    ctx.rotate((this.rotation * Math.PI) / 2);
    ctx.drawImage(b, -b.width / 2, -b.height / 2);
    this.rotated = c;
    this.rotatedKey = key;
    return c;
  }

  // ---------- Painting ----------

  /** Repaint the on-screen canvas, fitted into the stage. */
  private redraw(): void {
    if (!this.base || !this.display) return;
    const view = this.viewRect();
    // The stage has 6px padding per side — subtract it so the canvas fits.
    const stageW = Math.max(120, (this.stageEl.clientWidth || Math.round(window.innerWidth * 0.8) || 320) - 14);
    const stageH = Math.max(160, Math.min(window.innerHeight * 0.48, 560));
    const scale = Math.min(stageW / view.w, stageH / view.h);
    this.scale = scale;

    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.round(view.w * scale));
    const cssH = Math.max(1, Math.round(view.h * scale));
    const c = this.display;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;

    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(this.getRotated(), view.x, view.y, view.w, view.h, 0, 0, cssW, cssH);
    this.paintStrokes(ctx, this.strokes, view, scale);

    // Live crop marquee: dim everything outside the selection.
    if (this.dragRect) {
      const r = this.dragRect;
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(0, 0, cssW, r.y * scale);
      ctx.fillRect(0, (r.y + r.h) * scale, cssW, cssH - (r.y + r.h) * scale);
      ctx.fillRect(0, r.y * scale, r.x * scale, r.h * scale);
      ctx.fillRect((r.x + r.w) * scale, r.y * scale, cssW - (r.x + r.w) * scale, r.h * scale);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      ctx.setLineDash([]);
    }
  }

  /** Draw strokes (plus the in-progress one) mapped through the current view. */
  private paintStrokes(
    ctx: CanvasRenderingContext2D,
    strokes: Stroke[],
    view: Rect,
    scale: number
  ): void {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = this.drawing ? [...strokes, this.drawing] : strokes;
    for (const s of all) {
      if (s.points.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, s.width * scale);
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = (p.x - view.x) * scale;
        const y = (p.y - view.y) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // A single tap should still leave a dot.
      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.lineTo((p.x - view.x) * scale + 0.01, (p.y - view.y) * scale);
      }
      ctx.stroke();
    }
  }

  // ---------- Pointer input ----------

  private bindPointer(): void {
    const c = this.display;
    c.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === "mouse") return;
      ev.preventDefault();
      c.setPointerCapture(ev.pointerId);
      if (this.tool === "crop") {
        this.dragAnchor = this.toView(ev);
        this.dragRect = { x: this.dragAnchor.x, y: this.dragAnchor.y, w: 0, h: 0 };
      } else {
        this.pushHistory();
        this.drawing = { color: this.color, width: this.width, points: [this.toImage(ev)] };
      }
      this.redraw();
    });

    c.addEventListener("pointermove", (ev) => {
      if (this.tool === "crop") {
        if (!this.dragAnchor) return;
        ev.preventDefault();
        const p = this.toView(ev);
        const v = this.viewRect();
        const x1 = clamp(Math.min(this.dragAnchor.x, p.x), 0, v.w);
        const y1 = clamp(Math.min(this.dragAnchor.y, p.y), 0, v.h);
        const x2 = clamp(Math.max(this.dragAnchor.x, p.x), 0, v.w);
        const y2 = clamp(Math.max(this.dragAnchor.y, p.y), 0, v.h);
        this.dragRect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        this.redraw();
      } else if (this.drawing) {
        ev.preventDefault();
        this.drawing.points.push(this.toImage(ev));
        this.redraw();
      }
    });

    const end = (ev: PointerEvent): void => {
      if (this.tool === "crop") {
        const r = this.dragRect;
        this.dragAnchor = null;
        this.dragRect = null;
        if (r && r.w >= MIN_CROP / this.scale && r.h >= MIN_CROP / this.scale) {
          this.pushHistory();
          const v = this.viewRect();
          this.crop = { x: r.x + v.x, y: r.y + v.y, w: r.w, h: r.h };
        }
        this.redraw();
      } else if (this.drawing) {
        if (this.drawing.points.length > 0) this.strokes.push(this.drawing);
        this.drawing = null;
        this.redraw();
      }
      try { c.releasePointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    // Stop the mobile keyboard/page from scrolling while drawing.
    c.addEventListener("touchstart", (ev) => ev.preventDefault(), { passive: false });
  }

  /** Pointer position in view coordinates (origin = crop top-left). */
  private toView(ev: PointerEvent): Point {
    const rect = this.display.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) / this.scale,
      y: (ev.clientY - rect.top) / this.scale,
    };
  }

  /** Pointer position in rotated-image coordinates. */
  private toImage(ev: PointerEvent): Point {
    const p = this.toView(ev);
    const v = this.viewRect();
    return { x: p.x + v.x, y: p.y + v.y };
  }

  // ---------- Edits ----------

  private pushHistory(): void {
    this.modified = true;
    this.history.push({
      rotation: this.rotation,
      crop: this.crop ? { ...this.crop } : null,
      strokes: this.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
    });
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /** Rotate 90° clockwise, carrying the crop and annotations along. */
  private rotateCW(): void {
    const prevH = this.rotatedSize().h;
    this.pushHistory();
    this.rotation = (this.rotation + 1) % 4;
    if (this.crop) {
      const c = this.crop;
      this.crop = { x: prevH - c.y - c.h, y: c.x, w: c.h, h: c.w };
    }
    this.strokes = this.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ x: prevH - p.y, y: p.x })),
    }));
    this.redraw();
  }

  /** Rotate 90° counter-clockwise, carrying the crop and annotations along. */
  private rotateCCW(): void {
    const prevW = this.rotatedSize().w;
    this.pushHistory();
    this.rotation = (this.rotation + 3) % 4;
    if (this.crop) {
      const c = this.crop;
      this.crop = { x: c.y, y: prevW - c.x - c.w, w: c.h, h: c.w };
    }
    this.strokes = this.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ x: p.y, y: prevW - p.x })),
    }));
    this.redraw();
  }

  private undo(): void {
    const snap = this.history.pop();
    if (!snap) return;
    this.rotation = snap.rotation;
    this.crop = snap.crop;
    this.strokes = snap.strokes;
    this.rotated = undefined;
    this.rotatedKey = "";
    this.modified = this.history.length > 0;
    this.redraw();
  }

  private resetAll(): void {
    this.rotation = 0;
    this.crop = null;
    this.strokes = [];
    this.history = [];
    this.drawing = null;
    this.dragRect = null;
    this.dragAnchor = null;
    this.modified = false;
    this.rotated = undefined;
    this.rotatedKey = "";
    this.redraw();
  }

  // ---------- UI ----------

  private renderToolbar(containerEl: HTMLElement): void {
    const tools = containerEl.createDiv({ cls: "cagent-img-editor-tools" });

    const cropBtn = this.toolButton(tools, "crop", "imageEditorCrop", () => {
      this.tool = "crop";
      syncToolButtons();
    });
    const drawBtn = this.toolButton(tools, "pencil", "imageEditorDraw", () => {
      this.tool = "draw";
      syncToolButtons();
    });
    const syncToolButtons = (): void => {
      cropBtn.toggleClass("is-active", this.tool === "crop");
      drawBtn.toggleClass("is-active", this.tool === "draw");
    };
    syncToolButtons();

    tools.createDiv({ cls: "cagent-img-editor-sep" });

    this.toolButton(tools, "rotate-ccw", "imageEditorRotateLeft", () => this.rotateCCW());
    this.toolButton(tools, "rotate-cw", "imageEditorRotateRight", () => this.rotateCW());

    tools.createDiv({ cls: "cagent-img-editor-sep" });

    this.toolButton(tools, "undo", "imageEditorUndo", () => this.undo());
    this.toolButton(tools, "refresh-cw", "imageEditorReset", () => this.resetAll());

    tools.createDiv({ cls: "cagent-img-editor-sep" });

    // Colour swatches.
    for (const color of COLORS) {
      const sw = tools.createEl("button", {
        cls: "cagent-img-editor-swatch",
        attr: { "aria-label": this.tr("imageEditorColor"), type: "button" },
      });
      sw.style.background = color;
      sw.toggleClass("is-active", color === this.color);
      sw.addEventListener("click", () => {
        this.color = color;
        this.tool = "draw";
        syncToolButtons();
        tools.querySelectorAll<HTMLElement>(".cagent-img-editor-swatch").forEach((el) => el.removeClass("is-active"));
        sw.addClass("is-active");
      });
    }

    // Pen widths.
    tools.createDiv({ cls: "cagent-img-editor-sep" });
    for (const width of WIDTHS) {
      const btn = tools.createEl("button", {
        cls: "cagent-img-editor-size",
        attr: { "aria-label": this.tr("imageEditorSize"), type: "button" },
      });
      const dot = btn.createSpan();
      const dotSize = Math.min(16, 4 + width);
      dot.style.width = `${dotSize}px`;
      dot.style.height = `${dotSize}px`;
      btn.toggleClass("is-active", width === this.width);
      btn.addEventListener("click", () => {
        this.width = width;
        this.tool = "draw";
        syncToolButtons();
        tools.querySelectorAll<HTMLElement>(".cagent-img-editor-size").forEach((el) => el.removeClass("is-active"));
        btn.addClass("is-active");
      });
    }

    containerEl.createDiv({ cls: "cagent-img-editor-hint", text: this.tr("imageEditorHint") });
  }

  private toolButton(
    parent: HTMLElement,
    icon: string,
    labelKey: Key,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: "cagent-img-editor-btn",
      attr: { "aria-label": this.tr(labelKey), title: this.tr(labelKey), type: "button" },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private renderActions(containerEl: HTMLElement): void {
    const row = containerEl.createDiv({ cls: "cagent-img-editor-actions" });
    const cancel = row.createEl("button", { text: this.tr("imageEditorCancel") });
    cancel.addEventListener("click", () => this.close());
    const done = row.createEl("button", { cls: "mod-cta", text: this.tr("imageEditorDone") });
    done.addEventListener("click", () => this.exportImage());
  }

  // ---------- Export ----------

  /** Flatten rotation + crop + annotations into a JPEG and hand it back. */
  private exportImage(): void {
    // Nothing touched and no downscale needed? Keep the original bytes as-is
    // (avoids re-encoding the JPEG and losing a little quality for nothing).
    if (!this.modified && !this.downscaled) {
      this.opts.onSave(this.opts.image);
      this.close();
      return;
    }
    const view = this.viewRect();
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(view.w));
    c.height = Math.max(1, Math.round(view.h));
    const ctx = c.getContext("2d");
    if (!ctx) {
      this.opts.onSave(this.opts.image);
      this.close();
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.getRotated(), view.x, view.y, view.w, view.h, 0, 0, view.w, view.h);
    this.paintStrokes(ctx, this.strokes, view, 1);
    this.opts.onSave(c.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1]);
    this.close();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
