import type { ViewState } from '../../kernel/view'
import { SEGMENT_STRIDE, STYLE_WORDS, type BatchId, type Draw, type RenderBackend } from '../backend'
import { gridParams } from '../grid'
import { splitDouble } from '../hilo'
import { GRID_FRAG, GRID_VERT, SEGMENT_FRAG, SEGMENT_VERT } from './shaders'

export interface WebGL2Backend extends RenderBackend {
  /** Removes the canvas listeners and frees every GPU resource. The canvas context stays alive. */
  dispose(): void
}

interface Batch {
  capacity: number
  buffer: WebGLBuffer | null
  cpu: Uint8Array
}

type Rgba = [number, number, number, number]

/** Resolves any CSS color held by a custom property (alpha included) to 0..1 RGBA. */
export function readCssColor(canvas: HTMLCanvasElement, name: string): Rgba {
  const value = getComputedStyle(canvas).getPropertyValue(name).trim()
  const ctx = document.createElement('canvas').getContext('2d')
  if (!value || !ctx) throw new Error(`cannot resolve CSS color ${name}`)
  // An unparsable value leaves fillStyle untouched, so two different sentinels read back differently.
  ctx.fillStyle = '#010203'
  ctx.fillStyle = value
  const s = ctx.fillStyle
  ctx.fillStyle = '#040506'
  ctx.fillStyle = value
  if (ctx.fillStyle !== s) throw new Error(`cannot resolve CSS color ${name}: ${value}`)
  // fillStyle reads back as '#rrggbb' or 'rgba(r, g, b, a)'.
  if (s.startsWith('#')) {
    const n = parseInt(s.slice(1), 16)
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s)
  const parts = m?.[1]?.split(',').map(Number)
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) throw new Error(`cannot resolve CSS color ${name}: ${value}`)
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, parts[3] ?? 1]
}

export function createWebGL2Backend(canvas: HTMLCanvasElement): WebGL2Backend {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: false, stencil: false })
  if (!gl) throw new Error('WebGL2 is not available: the canvas could not create a webgl2 context')

  const bg = readCssColor(canvas, '--bg')
  const gridMinor = readCssColor(canvas, '--grid-minor')
  const gridMajor = readCssColor(canvas, '--grid-major')
  const batches = new Map<BatchId, Batch>()
  let nextId = 1
  let styleCopy = new Uint32Array(0)
  let lastFrame: { view: ViewState; draws: readonly Draw[] } | undefined
  const eye = new Float32Array(4)

  let program: WebGLProgram | null = null
  let vao: WebGLVertexArrayObject | null = null
  let styleTex: WebGLTexture | null = null
  let u!: Record<'eyeHi' | 'eyeLo' | 'pxPerUnit' | 'dpr' | 'viewportPx' | 'styles', WebGLUniformLocation | null>
  let gridProgram: WebGLProgram | null = null
  let gridVao: WebGLVertexArrayObject | null = null
  let gu!: Record<
    'viewportPx' | 'dpr' | 'bgColor' | 'minorColor' | 'majorColor' | 'phaseMinor' | 'phaseMajor' | 'spacingMinor' | 'spacingMajor' | 'fade' | 'blend',
    WebGLUniformLocation | null
  >

  function compile(type: number, src: string): WebGLShader {
    const sh = gl!.createShader(type)!
    gl!.shaderSource(sh, src)
    gl!.compileShader(sh)
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      const log = gl!.getShaderInfoLog(sh)
      gl!.deleteShader(sh)
      throw new Error(`shader compile failed: ${log}`)
    }
    return sh
  }

  function link(vertSrc: string, fragSrc: string): WebGLProgram {
    const vs = compile(gl!.VERTEX_SHADER, vertSrc)
    const fs = compile(gl!.FRAGMENT_SHADER, fragSrc)
    const p = gl!.createProgram()
    gl!.attachShader(p, vs)
    gl!.attachShader(p, fs)
    gl!.linkProgram(p)
    gl!.deleteShader(vs)
    gl!.deleteShader(fs)
    if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) {
      const log = gl!.getProgramInfoLog(p)
      gl!.deleteProgram(p)
      throw new Error(`program link failed: ${log}`)
    }
    return p
  }

  function buildGrid(): void {
    const p = link(GRID_VERT, GRID_FRAG)
    gridProgram = p
    gridVao = gl!.createVertexArray() // attribute-less: bound only because WebGL2 needs a VAO state
    const names = ['viewportPx', 'dpr', 'bgColor', 'minorColor', 'majorColor', 'phaseMinor', 'phaseMajor', 'spacingMinor', 'spacingMajor', 'fade', 'blend'] as const
    gu = Object.fromEntries(names.map((n) => [n, gl!.getUniformLocation(p, n)])) as typeof gu
  }

  function buildProgram(): void {
    const p = link(SEGMENT_VERT, SEGMENT_FRAG)
    program = p
    u = {
      eyeHi: gl!.getUniformLocation(p, 'eyeHi'),
      eyeLo: gl!.getUniformLocation(p, 'eyeLo'),
      pxPerUnit: gl!.getUniformLocation(p, 'pxPerUnit'),
      dpr: gl!.getUniformLocation(p, 'dpr'),
      viewportPx: gl!.getUniformLocation(p, 'viewportPx'),
      styles: gl!.getUniformLocation(p, 'styles'),
    }
    vao = gl!.createVertexArray()
    gl!.bindVertexArray(vao)
    for (const loc of [0, 1, 2]) {
      gl!.enableVertexAttribArray(loc)
      gl!.vertexAttribDivisor(loc, 1)
    }
  }

  function uploadStyles(): void {
    styleTex = gl!.createTexture()
    gl!.bindTexture(gl!.TEXTURE_2D, styleTex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST)
    const rows = styleCopy.length / STYLE_WORDS
    // An empty table still needs a valid texture; no instance can reference it meaningfully.
    const data = rows > 0 ? styleCopy : new Uint32Array(STYLE_WORDS)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R32UI, STYLE_WORDS, Math.max(1, rows), 0, gl!.RED_INTEGER, gl!.UNSIGNED_INT, data)
  }

  function uploadBatch(b: Batch): void {
    b.buffer = gl!.createBuffer()
    gl!.bindBuffer(gl!.ARRAY_BUFFER, b.buffer)
    gl!.bufferData(gl!.ARRAY_BUFFER, b.cpu, gl!.DYNAMIC_DRAW)
  }

  // Opaque and fullscreen, so it also replaces the clear.
  function drawGrid(view: ViewState): void {
    const g = gridParams(view)
    const k = view.dpr
    gl!.disable(gl!.BLEND)
    gl!.useProgram(gridProgram)
    gl!.bindVertexArray(gridVao)
    gl!.uniform2f(gu.viewportPx, canvas.width, canvas.height)
    gl!.uniform1f(gu.dpr, k)
    gl!.uniform4fv(gu.bgColor, bg)
    gl!.uniform4fv(gu.minorColor, gridMinor)
    gl!.uniform4fv(gu.majorColor, gridMajor)
    gl!.uniform2f(gu.phaseMinor, g.phaseMinor.x * k, g.phaseMinor.y * k)
    gl!.uniform2f(gu.phaseMajor, g.phaseMajor.x * k, g.phaseMajor.y * k)
    gl!.uniform1f(gu.spacingMinor, g.spacingPx * k)
    gl!.uniform1f(gu.spacingMajor, g.spacingPx * 10 * k)
    gl!.uniform1f(gu.fade, g.fade)
    gl!.uniform1f(gu.blend, g.blend)
    gl!.drawArrays(gl!.TRIANGLES, 0, 3)
  }

  function drawFrame(view: ViewState, draws: readonly Draw[]): void {
    gl!.viewport(0, 0, canvas.width, canvas.height)
    drawGrid(view)
    gl!.enable(gl!.BLEND)
    gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA)
    gl!.useProgram(program)
    gl!.bindVertexArray(vao)
    gl!.activeTexture(gl!.TEXTURE0)
    gl!.bindTexture(gl!.TEXTURE_2D, styleTex)
    gl!.uniform1i(u.styles, 0)
    splitDouble(view.cx, eye, 0)
    splitDouble(view.cy, eye, 2)
    gl!.uniform2f(u.eyeHi, eye[0]!, eye[2]!)
    gl!.uniform2f(u.eyeLo, eye[1]!, eye[3]!)
    gl!.uniform1f(u.pxPerUnit, view.scale * view.dpr)
    gl!.uniform1f(u.dpr, view.dpr)
    gl!.uniform2f(u.viewportPx, canvas.width, canvas.height)
    for (const d of draws) {
      // A restore replays the last frame, whose batches may have been destroyed since.
      const b = batches.get(d.batch)
      if (!b || d.count === 0) continue
      gl!.bindBuffer(gl!.ARRAY_BUFFER, b.buffer)
      // No base instance in WebGL2: the first instance is a byte offset on every attribute.
      const o = d.first * SEGMENT_STRIDE
      gl!.vertexAttribPointer(0, 4, gl!.FLOAT, false, SEGMENT_STRIDE, o)
      gl!.vertexAttribPointer(1, 4, gl!.FLOAT, false, SEGMENT_STRIDE, o + 16)
      gl!.vertexAttribIPointer(2, 1, gl!.UNSIGNED_INT, SEGMENT_STRIDE, o + 32)
      gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 4, d.count)
    }
  }

  function getBatch(id: BatchId): Batch {
    const b = batches.get(id)
    if (!b) throw new Error(`unknown batch ${id}`)
    return b
  }

  function onLost(e: Event): void {
    e.preventDefault()
  }
  function onRestored(): void {
    buildGrid()
    buildProgram()
    uploadStyles()
    for (const b of batches.values()) uploadBatch(b)
    if (lastFrame) drawFrame(lastFrame.view, lastFrame.draws)
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  buildGrid()
  buildProgram()
  uploadStyles()

  return {
    createBatch(kind, capacity) {
      if (kind === 'arc') throw new Error('arc batches arrive in T08')
      const b: Batch = { capacity, buffer: null, cpu: new Uint8Array(capacity * SEGMENT_STRIDE) }
      uploadBatch(b)
      const id = nextId++
      batches.set(id, b)
      return id
    },

    writeBatch(id, first, instances) {
      const b = getBatch(id)
      const bytes = new Uint8Array(instances.buffer, instances.byteOffset, instances.byteLength)
      if (bytes.length % SEGMENT_STRIDE !== 0) throw new RangeError(`write size ${bytes.length} is not a multiple of ${SEGMENT_STRIDE}`)
      if (!Number.isInteger(first) || first < 0 || first + bytes.length / SEGMENT_STRIDE > b.capacity) {
        throw new RangeError(`write [${first}, +${bytes.length / SEGMENT_STRIDE}) exceeds capacity ${b.capacity}`)
      }
      b.cpu.set(bytes, first * SEGMENT_STRIDE)
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, first * SEGMENT_STRIDE, bytes)
    },

    destroyBatch(id) {
      const b = getBatch(id)
      gl.deleteBuffer(b.buffer)
      batches.delete(id)
    },

    setStyleTable(table) {
      if (table.length % STYLE_WORDS !== 0) throw new RangeError(`style table length ${table.length} is not a multiple of ${STYLE_WORDS}`)
      styleCopy = table.slice()
      gl.deleteTexture(styleTex)
      uploadStyles()
    },

    frame(view, draws) {
      for (const d of draws) {
        const b = getBatch(d.batch)
        if (!Number.isInteger(d.first) || !Number.isInteger(d.count) || d.first < 0 || d.count < 0 || d.first + d.count > b.capacity) {
          throw new RangeError(`draw [${d.first}, +${d.count}) exceeds capacity ${b.capacity}`)
        }
      }
      lastFrame = { view, draws }
      if (gl.isContextLost()) return
      drawFrame(view, draws)
    },

    resize(width, height, dpr) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
    },

    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      for (const b of batches.values()) gl.deleteBuffer(b.buffer)
      batches.clear()
      gl.deleteTexture(styleTex)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(program)
      gl.deleteVertexArray(gridVao)
      gl.deleteProgram(gridProgram)
    },
  }
}
