/** GLSL for the compositor. Layers are quads drawn into a scene buffer; masks and fades run as full-screen passes. */

export const QUAD_VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;   // x, y, w, h in clip-space-ready canvas fractions (y down)
uniform vec4 u_uv;     // u0, v0, u1, v1 of the source after crop
uniform bool u_flip;
out vec2 v_uv;
out vec2 v_local;
void main() {
  vec2 p = u_rect.xy + a_pos * u_rect.zw;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  vec2 t = u_flip ? vec2(1.0 - a_pos.x, a_pos.y) : a_pos;
  v_uv = mix(u_uv.xy, u_uv.zw, t);
  v_local = a_pos;
}`;

export const LAYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_local;
uniform sampler2D u_tex;
uniform bool u_solid;
uniform vec4 u_color;
uniform float u_opacity;
uniform vec2 u_size;      // layer size in pixels
uniform float u_radius;   // corner radius in pixels
uniform bool u_circle;
uniform bool u_chroma;
uniform vec3 u_key;
uniform float u_similarity;
uniform float u_smoothness;
out vec4 o;

// Chroma distance in YCbCr: brightness changes of the backdrop matter less than hue.
vec2 cbcr(vec3 c) {
  return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b);
}

void main() {
  vec4 c = u_solid ? u_color : texture(u_tex, v_uv);
  if (u_chroma) {
    float d = distance(cbcr(c.rgb), cbcr(u_key));
    float a = smoothstep(u_similarity * 0.5, u_similarity * 0.5 + u_smoothness * 0.5 + 0.001, d);
    c.a *= a;
    // Spill: pull the key colour out of edges.
    c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), (1.0 - a) * 0.5);
  }
  vec2 p = v_local * u_size;
  float edge;
  if (u_circle) {
    float r = min(u_size.x, u_size.y) * 0.5;
    edge = length(p - u_size * 0.5) - r;
  } else {
    vec2 q = abs(p - u_size * 0.5) - (u_size * 0.5 - vec2(u_radius));
    edge = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
  }
  float mask = 1.0 - smoothstep(-1.0, 0.5, edge);
  float a = c.a * u_opacity * mask;
  o = vec4(c.rgb * a, a);  // premultiplied
}`;

export const FULL_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
// Scene buffers hold the canvas top at v = 1 (the layer pass draws y-down into clip space).
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Copies the scene buffer, blacking out or pixelating each privacy mask. */
export const MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_canvas;
uniform int u_count;
uniform vec4 u_rects[8];   // x, y, w, h (fractions, y down)
uniform vec4 u_colors[8];  // rgb, mode (0 = solid, 1 = pixelate)
uniform float u_blocks[8];
out vec4 o;
void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);  // y down, like the rects
  vec4 c = texture(u_tex, v_uv);
  for (int i = 0; i < 8; i++) {
    if (i >= u_count) break;
    vec4 r = u_rects[i];
    if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.z && p.y <= r.y + r.w) {
      if (u_colors[i].a < 0.5) {
        c = vec4(u_colors[i].rgb, 1.0);
      } else {
        vec2 px = p * u_canvas;
        vec2 cell = (floor(px / u_blocks[i]) + 0.5) * u_blocks[i] / u_canvas;
        c = texture(u_tex, vec2(cell.x, 1.0 - cell.y));
      }
    }
  }
  o = c;
}`;

/** Draws one or two scene buffers to the canvas, cross-fading by u_t. */
export const MIX_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_t;
out vec4 o;
void main() {
  vec4 a = texture(u_a, v_uv);
  vec4 b = texture(u_b, v_uv);
  vec4 c = mix(a, b, u_t);
  o = vec4(c.rgb, 1.0);
}`;
