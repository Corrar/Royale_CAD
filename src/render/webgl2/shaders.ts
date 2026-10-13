// Segment: one instanced quad (TRIANGLE_STRIP, corner from gl_VertexID) per segment.
export const SEGMENT_VERT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

layout(location = 0) in vec4 p0; // x0hi, x0lo, y0hi, y0lo
layout(location = 1) in vec4 p1;
layout(location = 2) in uint styleId;

uniform vec2 eyeHi;
uniform vec2 eyeLo;
uniform float pxPerUnit; // device px per world unit
uniform float dpr;
uniform vec2 viewportPx; // drawing buffer size, device px
uniform usampler2D styles; // 2 texels per row: color 0xRRGGBBAA, width/64 px | visible << 16

flat out vec4 vColor;

void main() {
  int row = int(styleId);
  uint c = texelFetch(styles, ivec2(0, row), 0).r;
  uint w = texelFetch(styles, ivec2(1, row), 0).r;
  if (((w >> 16) & 1u) == 0u) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip: instance dropped
    vColor = vec4(0.0);
    return;
  }
  vColor = vec4(float((c >> 24) & 255u), float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0;
  float half_w = 0.5 * float(w & 0xFFFFu) / 64.0 * dpr;

  // The hi parts cancel exactly against eyeHi before the small residuals are added.
  vec2 a = vec2((p0.x - eyeHi.x) + (p0.y - eyeLo.x), (p0.z - eyeHi.y) + (p0.w - eyeLo.y)) * pxPerUnit;
  vec2 b = vec2((p1.x - eyeHi.x) + (p1.y - eyeLo.x), (p1.z - eyeHi.y) + (p1.w - eyeLo.y)) * pxPerUnit;

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

export const SEGMENT_FRAG =`#version 300 es
precision highp float;
flat in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vColor;
}
`
