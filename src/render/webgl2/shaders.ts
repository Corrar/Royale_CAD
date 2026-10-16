import { MAX_ARC_RADIUS_PX, MAX_SEGMENT_PX } from '../backend'

// Shared by the instanced programs: uniforms, style lookup and the hi/lo relative-to-eye subtraction.
const INSTANCED_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform vec2 eyeHi;
uniform vec2 eyeLo;
uniform float pxPerUnit; // device px per world unit
uniform float dpr;
uniform vec2 viewportPx; // drawing buffer size, device px
uniform usampler2D styles; // 2 texels per style: color 0xRRGGBBAA, width/64 px | visible << 16
uniform int stylesPerRow; // the table wraps into rows of this many styles

out vec4 vColor;

// Sets vColor and returns the half width in device px; false when the style is hidden.
bool loadStyle(uint styleId, out float halfW) {
  int id = int(styleId);
  ivec2 at = ivec2((id % stylesPerRow) * 2, id / stylesPerRow);
  uint c = texelFetch(styles, at, 0).r;
  uint w = texelFetch(styles, at + ivec2(1, 0), 0).r;
  halfW = 0.5 * float(w & 0xFFFFu) / 64.0 * dpr;
  vColor = vec4(float((c >> 24) & 255u), float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0;
  return ((w >> 16) & 1u) != 0u;
}

// The hi parts cancel exactly against eyeHi before the small residuals are added. Result in device px.
vec2 toEyePx(vec4 p) {
  return vec2((p.x - eyeHi.x) + (p.y - eyeLo.x), (p.z - eyeHi.y) + (p.w - eyeLo.y)) * pxPerUnit;
}

void drop() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip: instance dropped
}
`

// Segment: one instanced quad (TRIANGLE_STRIP, corner from gl_VertexID) per segment.
// After the eye subtraction everything is f32 in device px, so the error grows with the distance of the endpoints
// from the view centre: past ~5e6 px the visible stretch shifts >= 0.25 px when the eye moves, near 1.7e7 px the
// thickness doubles and at 1e8 px the line vanishes. Segments longer than MAX_SEGMENT_PX are dropped here and
// re-emitted by the caller, clipped in f64.
export const SEGMENT_VERT = INSTANCED_HEAD + `
layout(location = 0) in vec4 p0; // x0hi, x0lo, y0hi, y0lo
layout(location = 1) in vec4 p1;
layout(location = 2) in uint styleId;

void main() {
  float half_w;
  if (!loadStyle(styleId, half_w)) { drop(); return; }

  vec2 a = toEyePx(p0);
  vec2 b = toEyePx(p1);
  if (length(b - a) > ${MAX_SEGMENT_PX.toFixed(1)}) { drop(); return; }

  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  float t = float(gl_VertexID & 1);
  float side = float(gl_VertexID >> 1) * 2.0 - 1.0;
  // Square caps: the quad overshoots each end by half the width.
  vec2 pos = mix(a, b, t) + dir * (t * 2.0 - 1.0) * half_w + vec2(-dir.y, dir.x) * side * half_w;
  gl_Position = vec4(pos / (0.5 * viewportPx), 0.0, 1.0);
}
`

// Arc: one instanced TRIANGLE_STRIP of 2 * (subdiv + 1) vertices per arc, evaluated here.
// r, a0 and sweep are f32 and subdiv is capped at 4096, so past a radius of about 1e6 px an arc lands a few px off
// and loses thickness (the segment's f32 limit). Arcs with a radius above MAX_ARC_RADIUS_PX are dropped here and
// re-emitted by the caller, clipped and flattened in f64.
export const ARC_VERT = INSTANCED_HEAD + `
layout(location = 0) in vec4 c; // cxhi, cxlo, cyhi, cylo
layout(location = 1) in vec3 shape; // r, a0, sweep
layout(location = 2) in uint styleId;

uniform int subdiv;

void main() {
  float half_w;
  if (!loadStyle(styleId, half_w)) { drop(); return; }
  if (shape.x * pxPerUnit > ${MAX_ARC_RADIUS_PX.toFixed(1)}) { drop(); return; }

  float angle = shape.y + shape.z * float(gl_VertexID >> 1) / float(subdiv);
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  // The width offset is radial, so the stroke keeps a constant thickness. The inner radius stops at 0.
  vec2 pos = toEyePx(c) + max(shape.x * pxPerUnit + side * half_w, 0.0) * vec2(cos(angle), sin(angle));
  gl_Position = vec4(pos / (0.5 * viewportPx), 0.0, 1.0);
}
`

// Grid: one fullscreen triangle from gl_VertexID, no buffers.
export const GRID_VERT = `#version 300 es
void main() {
  gl_Position = vec4(float((gl_VertexID << 1) & 2) * 2.0 - 1.0, float(gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0);
}
`

// Distances are device px from the viewport centre. Phase (distance from the grid line below/left
// of the centre) arrives precomputed in f64 on the CPU.
export const GRID_FRAG = `#version 300 es
precision highp float;
uniform vec2 viewportPx;
uniform float dpr;
uniform vec4 bgColor;
uniform vec4 minorColor;
uniform vec4 majorColor;
uniform vec2 phaseMinor;
uniform vec2 phaseMajor;
uniform float spacingMinor;
uniform float spacingMajor;
uniform float fade;
uniform float blend;
out vec4 outColor;

// Coverage of a 1 CSS px line, antialiased over about one device px.
float coverage(vec2 d, vec2 phase, float spacing) {
  vec2 m = mod(d + phase, spacing);
  vec2 dist = min(m, spacing - m);
  vec2 c = clamp(0.5 * dpr + 0.5 - dist, 0.0, 1.0);
  return max(c.x, c.y);
}

void main() {
  vec2 d = gl_FragCoord.xy - 0.5 * viewportPx;
  vec4 minor = mix(minorColor, majorColor, blend);
  float aMinor = coverage(d, phaseMinor, spacingMinor) * minor.a * fade;
  float aMajor = coverage(d, phaseMajor, spacingMajor) * majorColor.a;
  // Where both levels coincide the stronger one wins; compositing both would pop at level changes.
  vec4 line = aMajor >= aMinor ? vec4(majorColor.rgb, aMajor) : vec4(minor.rgb, aMinor);
  outColor = vec4(mix(bgColor.rgb, line.rgb, line.a), 1.0);
}
`

// Glyph: one instanced quad per character, its corners from the glyph table (bounds in capital heights, uv).
// Only the origin needs the hi/lo split: the quad is a few capital heights across, f32 suffices.
export const GLYPH_VERT = INSTANCED_HEAD + `
layout(location = 0) in vec4 p; // xhi, xlo, yhi, ylo
layout(location = 1) in vec4 axes; // one capital height along the baseline (xy) and up (zw), world units
layout(location = 2) in uint styleId;
layout(location = 3) in uint glyph;

uniform highp sampler2D glyphTable; // 2 texels a glyph: bounds (l, b, r, t), uv (u0, v0, u1, v1)
uniform int glyphsPerRow;

out vec2 vUv;

void main() {
  float half_w;
  if (!loadStyle(styleId, half_w)) { drop(); return; }
  int g = int(glyph);
  ivec2 at = ivec2((g % glyphsPerRow) * 2, g / glyphsPerRow);
  vec4 bounds = texelFetch(glyphTable, at, 0);
  vec4 uv = texelFetch(glyphTable, at + ivec2(1, 0), 0);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 local = mix(bounds.xy, bounds.zw, corner);
  vec2 pos = toEyePx(p) + (local.x * axes.xy + local.y * axes.zw) * pxPerUnit;
  vUv = mix(uv.xy, uv.zw, corner);
  gl_Position = vec4(pos / (0.5 * viewportPx), 0.0, 1.0);
}
`

// Tri: one instanced triangle per filled triangle, its corner picked by gl_VertexID. The corners take the hi/lo
// subtraction like a segment's ends; a fill has no stroke, so the style's width goes unused.
export const TRI_VERT = INSTANCED_HEAD + `
layout(location = 0) in vec4 p0; // x0hi, x0lo, y0hi, y0lo
layout(location = 1) in vec4 p1;
layout(location = 2) in uint styleId;
layout(location = 3) in vec4 p2;

void main() {
  float half_w;
  if (!loadStyle(styleId, half_w)) { drop(); return; }
  // An edge past the segment limit is dropped, as a segment is: the caller re-emits the fill clipped in f64.
  vec2 a = toEyePx(p0);
  vec2 b = toEyePx(p1);
  vec2 c = toEyePx(p2);
  if (max(length(b - a), max(length(c - b), length(a - c))) > ${MAX_SEGMENT_PX.toFixed(1)}) { drop(); return; }
  vec2 p = gl_VertexID == 0 ? a : gl_VertexID == 1 ? b : c;
  gl_Position = vec4(p / (0.5 * viewportPx), 0.0, 1.0);
}
`

// The edge is where the distance field crosses 0.5; fwidth antialiases it over about a pixel at any size. Small
// text has strokes thinner than a pixel, which one sample per pixel would miss: four more samples, at the corners of
// a box half a pixel wide, are averaged in.
export const GLYPH_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vUv;
uniform sampler2D atlas;
out vec4 outColor;
float cover(vec2 uv, float w) {
  return smoothstep(0.5 - w, 0.5 + w, texture(atlas, uv).r);
}
void main() {
  float d = texture(atlas, vUv).r;
  float w = max(fwidth(d) * 0.7, 1e-4);
  float a = smoothstep(0.5 - w, 0.5 + w, d);
  vec2 du = 0.354 * (dFdx(vUv) + dFdy(vUv));
  vec2 dv = 0.354 * (dFdx(vUv) - dFdy(vUv));
  a = (a + 0.5 * (cover(vUv + du, w) + cover(vUv - du, w) + cover(vUv + dv, w) + cover(vUv - dv, w))) / 3.0;
  if (a <= 0.0) discard;
  outColor = vec4(vColor.rgb, vColor.a * a);
}
`

export const SEGMENT_FRAG =`#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vColor;
}
`
