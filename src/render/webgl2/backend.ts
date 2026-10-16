import type { ViewState } from '../../kernel/view'
import {
  ARC_STRIDE, GLYPH_STRIDE, MAX_ARC_SUBDIV, SEGMENT_STRIDE, STYLE_WORDS, type BackendTheme, type BatchId, type BatchKind, type Draw, type RenderBackend,
} from '../backend'
import type { GlyphUpload } from '../glyphs'
import { gridParams } from '../grid'
import { splitDouble } from '../hilo'
import { ARC_VERT, GLYPH_FRAG, GLYPH_VERT, GRID_FRAG, GRID_VERT, SEGMENT_FRAG, SEGMENT_VERT } from './shaders'

export interface WebGL2Backend extends RenderBackend {
  /** Removes the canvas listeners and frees every GPU resource. The canvas context stays alive. */
  dispose(): void
}

type Kind = BatchKind

interface Batch {
  kind: Kind
  capacity: number
  buffer: WebGLBuffer | null
}

interface Pipeline {
  program: WebGLProgram | null
  vao: WebGLVertexArrayObject | null
  u: Record<
    'eyeHi' | 'eyeLo' | 'pxPerUnit' | 'dpr' | 'viewportPx' | 'styles' | 'stylesPerRow' | 'subdiv' | 'glyphTable' | 'glyphsPerRow' | 'atlas',
    WebGLUniformLocation | null
  >
}

// The kinds share the attribute slots (vec4, float vector, uint styleId last); glyphs add their index before it.
const LAYOUT: Record<Kind, { stride: number; shapeSize: number; vert: string; frag: string }> = {
  segment: { stride: SEGMENT_STRIDE, shapeSize: 4, vert: SEGMENT_VERT, frag: SEGMENT_FRAG },
  arc: { stride: ARC_STRIDE, shapeSize: 3, vert: ARC_VERT, frag: SEGMENT_FRAG },
  glyph: { stride: GLYPH_STRIDE, shapeSize: 4, vert: GLYPH_VERT, frag: GLYPH_FRAG },
}
/** Glyphs per row of the glyph table texture, two texels each. */
const GLYPHS_PER_ROW = 1024

export function createWebGL2Backend(canvas: HTMLCanvasElement, theme: BackendTheme): WebGL2Backend {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: false, stencil: false })
  if (!gl) throw new Error('WebGL2 is not available: the canvas could not create a webgl2 context')

  // Copies: the caller may reuse its arrays, and uniform4fv takes a Float32Array.
  const bg = new Float32Array(theme.bg)
  const gridMinor = new Float32Array(theme.gridMinor)
  const gridMajor = new Float32Array(theme.gridMajor)
  // The style table wraps into rows of stylesPerRow styles, STYLE_WORDS texels each.
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  const stylesPerRow = Math.min(1024, Math.floor(maxTexture / STYLE_WORDS))
  const maxStyles = stylesPerRow * maxTexture
  const batches = new Map<BatchId, Batch>()
  let nextId = 1
  let styleCopy = new Uint32Array(0)
  const restoreListeners = new Set<() => void>()
  let gridVisible = true
  const eye = new Float32Array(4)

  const pipelines = {} as Record<Kind, Pipeline>
  let styleTex: WebGLTexture | null = null
  // The glyph atlas and its table, kept to upload again after a lost context.
  let glyphCopy: GlyphUpload | null = null
  let atlasTex: WebGLTexture | null = null
  let glyphTableTex: WebGLTexture | null = null
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

  function buildPipeline(kind: Kind): void {
    const p = link(LAYOUT[kind].vert, LAYOUT[kind].frag)
    const names = ['eyeHi', 'eyeLo', 'pxPerUnit', 'dpr', 'viewportPx', 'styles', 'stylesPerRow', 'subdiv', 'glyphTable', 'glyphsPerRow', 'atlas'] as const
    const vao = gl!.createVertexArray()
    pipelines[kind] = { program: p, vao, u: Object.fromEntries(names.map((n) => [n, gl!.getUniformLocation(p, n)])) as Pipeline['u'] }
    gl!.bindVertexArray(vao)
    for (const loc of kind === 'glyph' ? [0, 1, 2, 3] : [0, 1, 2]) {
      gl!.enableVertexAttribArray(loc)
      gl!.vertexAttribDivisor(loc, 1)
    }
  }

  /** The atlas (R8, filtered: the distances interpolate) and the glyph table (RGBA32F, 2 texels a glyph). */
  function uploadGlyphs(): void {
    gl!.deleteTexture(atlasTex)
    gl!.deleteTexture(glyphTableTex)
    atlasTex = gl!.createTexture()
    glyphTableTex = gl!.createTexture()
    const g = glyphCopy ?? { width: 1, height: 1, data: new Uint8Array(1), table: new Float32Array(8) }
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R8, g.width, g.height, 0, gl!.RED, gl!.UNSIGNED_BYTE, g.data)
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 4)
    const count = Math.max(1, g.table.length / 8)
    const rows = Math.ceil(count / GLYPHS_PER_ROW)
    const table = new Float32Array(rows * GLYPHS_PER_ROW * 8)
    table.set(g.table)
    gl!.bindTexture(gl!.TEXTURE_2D, glyphTableTex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA32F, GLYPHS_PER_ROW * 2, rows, 0, gl!.RGBA, gl!.FLOAT, table)
  }

  function uploadStyles(): void {
    styleTex = gl!.createTexture()
    gl!.bindTexture(gl!.TEXTURE_2D, styleTex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST)
    // An empty table still needs a valid texture; no instance can reference it meaningfully.
    const rows = Math.max(1, Math.ceil(styleCopy.length / STYLE_WORDS / stylesPerRow))
    const data = new Uint32Array(rows * stylesPerRow * STYLE_WORDS)
    data.set(styleCopy)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R32UI, stylesPerRow * STYLE_WORDS, rows, 0, gl!.RED_INTEGER, gl!.UNSIGNED_INT, data)
  }

  /** A zeroed buffer at the batch's capacity: zeroed instances have styleId 0, hidden. */
  function allocBatch(b: Batch): void {
    b.buffer = gl!.createBuffer()
    gl!.bindBuffer(gl!.ARRAY_BUFFER, b.buffer)
    gl!.bufferData(gl!.ARRAY_BUFFER, b.capacity * LAYOUT[b.kind].stride, gl!.DYNAMIC_DRAW)
  }

  // Opaque and fullscreen, so it also replaces the clear.
  function drawGrid(view: ViewState): void {
    if (!gridVisible) {
      gl!.clearColor(bg[0]!, bg[1]!, bg[2]!, bg[3]!)
      gl!.clear(gl!.COLOR_BUFFER_BIT)
      return
    }
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
    gl!.activeTexture(gl!.TEXTURE0)
    gl!.bindTexture(gl!.TEXTURE_2D, styleTex)
    gl!.activeTexture(gl!.TEXTURE1)
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex)
    gl!.activeTexture(gl!.TEXTURE2)
    gl!.bindTexture(gl!.TEXTURE_2D, glyphTableTex)
    splitDouble(view.cx, eye, 0)
    splitDouble(view.cy, eye, 2)
    let current: Kind | undefined
    for (const d of draws) {
      // A restore replays the last frame, whose batches may have been destroyed since.
      const b = batches.get(d.batch)
      if (!b || d.count === 0) continue
      const { stride, shapeSize } = LAYOUT[b.kind]
      const { program, vao, u } = pipelines[b.kind]
      if (current !== b.kind) {
        current = b.kind
        gl!.useProgram(program)
        gl!.bindVertexArray(vao)
        gl!.uniform1i(u.styles, 0)
        gl!.uniform1i(u.stylesPerRow, stylesPerRow)
        gl!.uniform2f(u.eyeHi, eye[0]!, eye[2]!)
        gl!.uniform2f(u.eyeLo, eye[1]!, eye[3]!)
        gl!.uniform1f(u.pxPerUnit, view.scale * view.dpr)
        gl!.uniform1f(u.dpr, view.dpr)
        gl!.uniform2f(u.viewportPx, canvas.width, canvas.height)
        if (b.kind === 'glyph') {
          gl!.uniform1i(u.atlas, 1)
          gl!.uniform1i(u.glyphTable, 2)
          gl!.uniform1i(u.glyphsPerRow, GLYPHS_PER_ROW)
        }
      }
      gl!.bindBuffer(gl!.ARRAY_BUFFER, b.buffer)
      // No base instance in WebGL2: the first instance is a byte offset on every attribute.
      const o = d.first * stride
      gl!.vertexAttribPointer(0, 4, gl!.FLOAT, false, stride, o)
      gl!.vertexAttribPointer(1, shapeSize, gl!.FLOAT, false, stride, o + 16)
      gl!.vertexAttribIPointer(2, 1, gl!.UNSIGNED_INT, stride, o + stride - 4)
      if (b.kind === 'glyph') gl!.vertexAttribIPointer(3, 1, gl!.UNSIGNED_INT, stride, o + 32)
      if (b.kind === 'arc') {
        gl!.uniform1i(u.subdiv, d.subdiv!)
        gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 2 * (d.subdiv! + 1), d.count)
      } else {
        gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 4, d.count)
      }
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
    buildPipeline('segment')
    buildPipeline('arc')
    buildPipeline('glyph')
    uploadStyles()
    uploadGlyphs()
    for (const b of batches.values()) allocBatch(b)
    for (const fn of [...restoreListeners]) fn()
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  buildGrid()
  buildPipeline('segment')
  buildPipeline('arc')
  buildPipeline('glyph')
  uploadStyles()
  uploadGlyphs()

  return {
    createBatch(kind, capacity) {
      const b: Batch = { kind, capacity, buffer: null }
      allocBatch(b)
      const id = nextId++
      batches.set(id, b)
      return id
    },

    writeBatch(id, first, instances) {
      const b = getBatch(id)
      const { stride } = LAYOUT[b.kind]
      const bytes = new Uint8Array(instances.buffer, instances.byteOffset, instances.byteLength)
      if (bytes.length % stride !== 0) throw new RangeError(`write size ${bytes.length} is not a multiple of ${stride}`)
      if (!Number.isInteger(first) || first < 0 || first + bytes.length / stride > b.capacity) {
        throw new RangeError(`write [${first}, +${bytes.length / stride}) exceeds capacity ${b.capacity}`)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, first * stride, bytes)
    },

    destroyBatch(id) {
      const b = getBatch(id)
      gl.deleteBuffer(b.buffer)
      batches.delete(id)
    },

    setStyleTable(table) {
      if (table.length % STYLE_WORDS !== 0) throw new RangeError(`style table length ${table.length} is not a multiple of ${STYLE_WORDS}`)
      if (table.length / STYLE_WORDS > maxStyles) throw new RangeError(`style table has ${table.length / STYLE_WORDS} styles, the limit is ${maxStyles}`)
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
        if (b.kind === 'arc' && !(Number.isInteger(d.subdiv) && d.subdiv! >= 1 && d.subdiv! <= MAX_ARC_SUBDIV)) {
          throw new RangeError(`arc draw needs an integer subdiv in [1, ${MAX_ARC_SUBDIV}], got ${d.subdiv}`)
        }
      }
      if (gl.isContextLost()) return
      drawFrame(view, draws)
    },

    resize(width, height, dpr) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
    },

    setGrid(visible) {
      gridVisible = visible
    },

    setGlyphs(glyphs) {
      glyphCopy = glyphs
      uploadGlyphs()
    },

    onRestore(fn) {
      const entry = (): void => fn()
      restoreListeners.add(entry)
      return () => restoreListeners.delete(entry)
    },

    dispose() {
      restoreListeners.clear()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      for (const b of batches.values()) gl.deleteBuffer(b.buffer)
      batches.clear()
      gl.deleteTexture(styleTex)
      gl.deleteTexture(atlasTex)
      gl.deleteTexture(glyphTableTex)
      for (const p of Object.values(pipelines)) {
        gl.deleteVertexArray(p.vao)
        gl.deleteProgram(p.program)
      }
      gl.deleteVertexArray(gridVao)
      gl.deleteProgram(gridProgram)
    },
  }
}
