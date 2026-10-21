/**
 * The program: a WebGL2 canvas at the output size. Each frame, the active
 * scene's layers are drawn back to front into a scene buffer, privacy masks
 * are applied on top (always — a mask cannot be hidden under a layer), and
 * the result is shown, cross-fading with the previous scene during a
 * transition. The canvas is what gets recorded and streamed, so nothing
 * that is not part of the picture (selection, placeholders) is drawn here.
 */
import type { Layer, Scene } from "../studio/scene";
import { FULL_VS, LAYER_FS, MASK_FS, MIX_FS, QUAD_VS } from "./shaders";

export interface LayerSource {
  el: TexImageSource;
  width: number;
  height: number;
  /** Re-uploaded every frame (video); otherwise only when `version` changes. */
  dynamic: boolean;
  version: number;
}

export type SourceFor = (layer: Layer) => LayerSource | null;

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
}

interface Tex {
  tex: WebGLTexture;
  version: number;
  el: TexImageSource | null;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

export const MAX_MASKS = 8;

function hex(c: string): [number, number, number] {
  const n = Number.parseInt(c.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Where a source of `sw`×`sh` lands in its layer box: letterboxed (contain) or cropped (cover). */
export function fit(
  layer: Pick<Layer, "rect" | "crop">,
  sw: number,
  sh: number,
  canvas: { width: number; height: number },
  mode: "contain" | "cover",
): { rect: [number, number, number, number]; uv: [number, number, number, number] } {
  const { rect, crop } = layer;
  let u0 = crop.l;
  let v0 = crop.t;
  let u1 = 1 - crop.r;
  let v1 = 1 - crop.b;
  const srcAspect = ((u1 - u0) * sw) / Math.max(1e-6, (v1 - v0) * sh);
  const boxAspect = (rect.w * canvas.width) / Math.max(1e-6, rect.h * canvas.height);
  let { x, y, w, h } = rect;
  if (mode === "contain") {
    if (srcAspect > boxAspect) {
      const nh = (w * canvas.width) / srcAspect / canvas.height;
      y += (h - nh) / 2;
      h = nh;
    } else {
      const nw = (h * canvas.height * srcAspect) / canvas.width;
      x += (w - nw) / 2;
      w = nw;
    }
  } else if (srcAspect > boxAspect) {
    const keep = boxAspect / srcAspect;
    const du = ((u1 - u0) * (1 - keep)) / 2;
    u0 += du;
    u1 -= du;
  } else {
    const keep = srcAspect / boxAspect;
    const dv = ((v1 - v0) * (1 - keep)) / 2;
    v0 += dv;
    v1 -= dv;
  }
  return { rect: [x, y, w, h], uv: [u0, v0, u1, v1] };
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private layerProg: WebGLProgram;
  private maskProg: WebGLProgram;
  private mixProg: WebGLProgram;
  private lu: Uniforms;
  private mu: Uniforms;
  private xu: Uniforms;
  private textures = new Map<string, Tex>();
  private targets: Target[] = [];
  private width = 0;
  private height = 0;
  private lost = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.layerProg = this.program(QUAD_VS, LAYER_FS);
    this.maskProg = this.program(FULL_VS, MASK_FS);
    this.mixProg = this.program(FULL_VS, MIX_FS);
    this.lu = this.uniforms(this.layerProg, [
      "u_rect",
      "u_uv",
      "u_flip",
      "u_tex",
      "u_solid",
      "u_color",
      "u_opacity",
      "u_size",
      "u_radius",
      "u_circle",
      "u_chroma",
      "u_key",
      "u_similarity",
      "u_smoothness",
    ]);
    this.mu = this.uniforms(this.maskProg, [
      "u_tex",
      "u_canvas",
      "u_count",
      "u_rects",
      "u_colors",
      "u_blocks",
    ]);
    this.xu = this.uniforms(this.mixProg, ["u_a", "u_b", "u_t"]);
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new Error("WebGL: out of resources");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const prog of [this.layerProg, this.maskProg, this.mixProg]) {
      const loc = gl.getAttribLocation(prog, "a_pos");
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    }
    this.quad = vao;
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error("WebGL: cannot create shader");
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    if (!p) throw new Error("WebGL: cannot create program");
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
    return p;
  }

  private uniforms(p: WebGLProgram, names: string[]): Uniforms {
    const out: Uniforms = {};
    for (const n of names) out[n] = this.gl.getUniformLocation(p, n);
    return out;
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error("WebGL: out of textures");
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.canvas.width = width;
    this.canvas.height = height;
    this.width = width;
    this.height = height;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    // 0: layers of scene A, 1: scene A, 2: layers of scene B, 3: scene B.
    this.targets = Array.from({ length: 4 }, () => {
      const tex = this.newTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      if (!fb) throw new Error("WebGL: out of framebuffers");
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Drops textures of layers that no longer exist. */
  prune(alive: Set<string>): void {
    for (const [id, t] of this.textures) {
      if (!alive.has(id)) {
        this.gl.deleteTexture(t.tex);
        this.textures.delete(id);
      }
    }
  }

  private upload(id: string, src: LayerSource): WebGLTexture | null {
    const gl = this.gl;
    let t = this.textures.get(id);
    if (!t) {
      t = { tex: this.newTexture(), version: -1, el: null };
      this.textures.set(id, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (src.dynamic || t.version !== src.version || t.el !== src.el) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.el);
        t.version = src.version;
        t.el = src.el;
      } catch {
        return null;
      }
    }
    return t.tex;
  }

  private drawScene(scene: Scene, sources: SourceFor, layersAt: number, out: number): void {
    const gl = this.gl;
    const W = this.width;
    const H = this.height;
    const canvas = { width: W, height: H };
    const layers = this.targets[layersAt] as Target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layers.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.layerProg);
    gl.bindVertexArray(this.quad);
    const u = this.lu;
    const masks: Layer[] = [];
    for (const layer of scene.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.kind === "mic") continue;
      if (layer.kind === "mask") {
        if (masks.length < MAX_MASKS) masks.push(layer);
        continue;
      }
      let rect: [number, number, number, number] = [
        layer.rect.x,
        layer.rect.y,
        layer.rect.w,
        layer.rect.h,
      ];
      let uv: [number, number, number, number] = [0, 0, 1, 1];
      if (layer.kind === "color") {
        const [r, g, b] = hex(layer.color ?? "#000000");
        gl.uniform1i(u.u_solid as WebGLUniformLocation, 1);
        gl.uniform4f(u.u_color as WebGLUniformLocation, r, g, b, 1);
      } else {
        const src = sources(layer);
        if (!src?.width || !src.height) continue;
        const tex = this.upload(layer.id, src);
        if (!tex) continue;
        if (layer.kind !== "text") {
          const f = fit(
            layer,
            src.width,
            src.height,
            canvas,
            layer.kind === "camera" ? "cover" : "contain",
          );
          rect = f.rect;
          uv = f.uv;
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(u.u_tex as WebGLUniformLocation, 0);
        gl.uniform1i(u.u_solid as WebGLUniformLocation, 0);
      }
      const pw = rect[2] * W;
      const ph = rect[3] * H;
      gl.uniform4f(u.u_rect as WebGLUniformLocation, ...rect);
      gl.uniform4f(u.u_uv as WebGLUniformLocation, ...uv);
      gl.uniform1i(u.u_flip as WebGLUniformLocation, layer.flip ? 1 : 0);
      gl.uniform1f(u.u_opacity as WebGLUniformLocation, layer.opacity);
      gl.uniform2f(u.u_size as WebGLUniformLocation, pw, ph);
      gl.uniform1f(u.u_radius as WebGLUniformLocation, layer.radius * Math.min(pw, ph));
      gl.uniform1i(u.u_circle as WebGLUniformLocation, layer.shape === "circle" ? 1 : 0);
      if (layer.chroma) {
        gl.uniform1i(u.u_chroma as WebGLUniformLocation, 1);
        gl.uniform3f(u.u_key as WebGLUniformLocation, ...hex(layer.chroma.color));
        gl.uniform1f(u.u_similarity as WebGLUniformLocation, layer.chroma.similarity);
        gl.uniform1f(u.u_smoothness as WebGLUniformLocation, layer.chroma.smoothness);
      } else gl.uniform1i(u.u_chroma as WebGLUniformLocation, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);

    // Masks: a full-screen copy that replaces each masked area.
    const target = this.targets[out] as Target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.useProgram(this.maskProg);
    const m = this.mu;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layers.tex);
    gl.uniform1i(m.u_tex as WebGLUniformLocation, 0);
    gl.uniform2f(m.u_canvas as WebGLUniformLocation, W, H);
    gl.uniform1i(m.u_count as WebGLUniformLocation, masks.length);
    const rects = new Float32Array(MAX_MASKS * 4);
    const colors = new Float32Array(MAX_MASKS * 4);
    const blocks = new Float32Array(MAX_MASKS);
    masks.forEach((l, i) => {
      rects.set([l.rect.x, l.rect.y, l.rect.w, l.rect.h], i * 4);
      const mask = l.mask ?? { mode: "solid", color: "#000000", block: 24 };
      colors.set([...hex(mask.color), mask.mode === "pixelate" ? 1 : 0], i * 4);
      blocks[i] = Math.max(4, mask.block * (H / 1080));
    });
    gl.uniform4fv(m.u_rects as WebGLUniformLocation, rects);
    gl.uniform4fv(m.u_colors as WebGLUniformLocation, colors);
    gl.uniform1fv(m.u_blocks as WebGLUniformLocation, blocks);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Renders `scene`, fading in from `from` while `t` < 1. */
  render(scene: Scene, sources: SourceFor, from?: { scene: Scene; t: number }): void {
    if (this.isLost || !this.width) return;
    const gl = this.gl;
    this.drawScene(scene, sources, 0, 1);
    const fading = from && from.t < 1;
    if (fading) this.drawScene(from.scene, sources, 2, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.mixProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, (this.targets[fading ? 3 : 1] as Target).tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, (this.targets[1] as Target).tex);
    gl.uniform1i(this.xu.u_a as WebGLUniformLocation, 0);
    gl.uniform1i(this.xu.u_b as WebGLUniformLocation, 1);
    gl.uniform1f(this.xu.u_t as WebGLUniformLocation, fading ? (from?.t ?? 1) : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.textures.clear();
    this.targets = [];
  }
}
