import type { BBox } from '../geom/vec'
import type { Emitter } from './writer'

/**
 * Handles of the objects every new file has, below FIRST_FREE_HANDLE. The structure is the minimum an AC1015
 * (AutoCAD 2000) DXF carries, after the DXF Reference: the nine symbol tables, the model and paper space blocks
 * and their layouts, and the root dictionary with the groups, layouts, multiline styles and plot style names.
 */
export const H = {
  blockRecordTable: '1',
  layerTable: '2',
  styleTable: '3',
  ltypeTable: '5',
  viewTable: '6',
  ucsTable: '7',
  vportTable: '8',
  appidTable: '9',
  dimstyleTable: 'A',
  rootDict: 'C',
  groupDict: 'D',
  plotStyleDict: 'E',
  plotStyleNormal: 'F',
  layer0: '10',
  styleStandard: '11',
  appidAcad: '12',
  ltypeByBlock: '14',
  ltypeByLayer: '15',
  ltypeContinuous: '16',
  mlineStyleDict: '17',
  mlineStyleStandard: '18',
  layoutDict: '1A',
  paperRecord: '1B',
  paperBlock: '1C',
  paperEndblk: '1D',
  paperLayout: '1E',
  modelRecord: '1F',
  modelBlock: '20',
  modelEndblk: '21',
  modelLayout: '22',
  dimstyleStandard: '27',
  vportActive: '29',
} as const

/** Handles from here on are free for layers and entities. */
export const FIRST_FREE_HANDLE = 0x100

export interface TemplateParts {
  /** The drawing's extents, for the header and the initial view; null when empty. */
  extents: BBox | null
  /** Writes the LAYER entries; returns how many it wrote. */
  layers(o: Emitter): number
  /** Writes the entities, owned by the model space record. */
  entities(o: Emitter): void
  /** The next free handle once layers and entities have taken theirs. */
  handseed(): string
}

const reactors = (o: Emitter, owner: string): void => {
  o.str(102, '{ACAD_REACTORS')
  o.str(330, owner)
  o.str(102, '}')
}

function table(o: Emitter, name: string, handle: string, count: number, extra?: () => void): void {
  o.str(0, 'TABLE')
  o.str(2, name)
  o.str(5, handle)
  o.str(330, '0')
  o.str(100, 'AcDbSymbolTable')
  o.int(70, count)
  extra?.()
}

function record(o: Emitter, type: string, handle: string, owner: string, subclass: string, name: string): void {
  o.str(0, type)
  o.str(type === 'DIMSTYLE' ? 105 : 5, handle)
  o.str(330, owner)
  o.str(100, 'AcDbSymbolTableRecord')
  o.str(100, subclass)
  o.str(2, name)
  o.int(70, 0)
}

function point(o: Emitter, code: number, x: number, y: number, z?: number): void {
  o.real(code, x)
  o.real(code + 10, y)
  if (z !== undefined) o.real(code + 20, z)
}

/** A3 landscape in millimetres: the sheet the app opens on. */
const SHEET = { minX: 0, minY: 0, maxX: 420, maxY: 297 }

function layout(o: Emitter, handle: string, name: string, tab: number, block: string, ext: BBox): void {
  o.str(0, 'LAYOUT')
  o.str(5, handle)
  reactors(o, H.layoutDict)
  o.str(330, H.layoutDict)
  o.str(100, 'AcDbPlotSettings')
  o.str(1, '')
  o.str(2, 'none_device')
  o.str(4, '')
  o.str(6, '')
  for (const [code, v] of [[40, 0], [41, 0], [42, 0], [43, 0], [44, 420], [45, 297], [46, 0], [47, 0], [48, 0], [49, 0], [140, 0], [141, 0], [142, 1], [143, 1]] as const) o.real(code, v)
  o.int(70, 688)
  o.int(72, 1)
  o.int(73, 0)
  o.int(74, 5)
  o.str(7, '')
  o.int(75, 16)
  o.real(147, 1)
  o.real(148, 0)
  o.real(149, 0)
  o.str(100, 'AcDbLayout')
  o.str(1, name)
  o.int(70, 1)
  o.int(71, tab)
  point(o, 10, SHEET.minX, SHEET.minY)
  point(o, 11, SHEET.maxX, SHEET.maxY)
  point(o, 12, 0, 0, 0)
  point(o, 14, ext.minX, ext.minY, 0)
  point(o, 15, ext.maxX, ext.maxY, 0)
  o.real(146, 0)
  point(o, 13, 0, 0, 0)
  point(o, 16, 1, 0, 0)
  point(o, 17, 0, 1, 0)
  o.int(76, 0)
  o.str(330, block)
}

function block(o: Emitter, h: string, end: string, owner: string, name: string, paper: boolean): void {
  o.str(0, 'BLOCK')
  o.str(5, h)
  o.str(330, owner)
  o.str(100, 'AcDbEntity')
  if (paper) o.int(67, 1)
  o.str(8, '0')
  o.str(100, 'AcDbBlockBegin')
  o.str(2, name)
  o.int(70, 0)
  point(o, 10, 0, 0, 0)
  o.str(3, name)
  o.str(1, '')
  o.str(0, 'ENDBLK')
  o.str(5, end)
  o.str(330, owner)
  o.str(100, 'AcDbEntity')
  if (paper) o.int(67, 1)
  o.str(8, '0')
  o.str(100, 'AcDbBlockEnd')
}

/** A new AC1015 file around the given layers and entities. */
export function writeTemplate(o: Emitter, parts: TemplateParts, scratch: () => Emitter): void {
  // Layers and entities take their handles first: the header needs the seed they leave.
  const layers = scratch()
  const layerCount = parts.layers(layers)
  const entities = scratch()
  parts.entities(entities)
  const ext = parts.extents ?? SHEET

  o.str(0, 'SECTION')
  o.str(2, 'HEADER')
  o.str(9, '$ACADVER')
  o.str(1, 'AC1015')
  o.str(9, '$DWGCODEPAGE')
  o.str(3, 'ANSI_1252')
  o.str(9, '$INSBASE')
  point(o, 10, 0, 0, 0)
  o.str(9, '$EXTMIN')
  point(o, 10, ext.minX, ext.minY, 0)
  o.str(9, '$EXTMAX')
  point(o, 10, ext.maxX, ext.maxY, 0)
  o.str(9, '$LIMMIN')
  point(o, 10, SHEET.minX, SHEET.minY)
  o.str(9, '$LIMMAX')
  point(o, 10, SHEET.maxX, SHEET.maxY)
  o.str(9, '$CLAYER')
  o.str(8, '0')
  o.str(9, '$MEASUREMENT')
  o.int(70, 1)
  o.str(9, '$INSUNITS')
  o.int(70, 4)
  o.str(9, '$HANDSEED')
  o.str(5, parts.handseed())
  o.str(0, 'ENDSEC')

  o.str(0, 'SECTION')
  o.str(2, 'CLASSES')
  o.str(0, 'ENDSEC')

  o.str(0, 'SECTION')
  o.str(2, 'TABLES')
  table(o, 'VPORT', H.vportTable, 1)
  record(o, 'VPORT', H.vportActive, H.vportTable, 'AcDbViewportTableRecord', '*Active')
  point(o, 10, 0, 0)
  point(o, 11, 1, 1)
  // The view opens on the drawing.
  point(o, 12, (ext.minX + ext.maxX) / 2, (ext.minY + ext.maxY) / 2)
  point(o, 13, 0, 0)
  point(o, 14, 10, 10)
  point(o, 15, 10, 10)
  point(o, 16, 0, 0, 1)
  point(o, 17, 0, 0, 0)
  o.real(40, Math.max(ext.maxY - ext.minY, (ext.maxX - ext.minX) / 1.5, 1) * 1.1)
  o.real(41, 1.5)
  o.real(42, 50)
  o.real(43, 0)
  o.real(44, 0)
  o.real(50, 0)
  o.real(51, 0)
  for (const [code, v] of [[71, 0], [72, 100], [73, 1], [74, 3], [75, 0], [76, 0], [77, 0], [78, 0]] as const) o.int(code, v)
  o.str(0, 'ENDTAB')

  table(o, 'LTYPE', H.ltypeTable, 3)
  for (const [h, name, text] of [[H.ltypeByBlock, 'ByBlock', ''], [H.ltypeByLayer, 'ByLayer', ''], [H.ltypeContinuous, 'Continuous', 'Solid line']] as const) {
    record(o, 'LTYPE', h, H.ltypeTable, 'AcDbLinetypeTableRecord', name)
    o.str(3, text)
    o.int(72, 65)
    o.int(73, 0)
    o.real(40, 0)
  }
  o.str(0, 'ENDTAB')

  table(o, 'LAYER', H.layerTable, layerCount)
  o.raw(layers.text())
  o.str(0, 'ENDTAB')

  table(o, 'STYLE', H.styleTable, 1)
  record(o, 'STYLE', H.styleStandard, H.styleTable, 'AcDbTextStyleTableRecord', 'Standard')
  o.real(40, 0)
  o.real(41, 1)
  o.real(50, 0)
  o.int(71, 0)
  o.real(42, 2.5)
  o.str(3, 'txt')
  o.str(4, '')
  o.str(0, 'ENDTAB')

  table(o, 'VIEW', H.viewTable, 0)
  o.str(0, 'ENDTAB')
  table(o, 'UCS', H.ucsTable, 0)
  o.str(0, 'ENDTAB')

  table(o, 'APPID', H.appidTable, 1)
  record(o, 'APPID', H.appidAcad, H.appidTable, 'AcDbRegAppTableRecord', 'ACAD')
  o.str(0, 'ENDTAB')

  table(o, 'DIMSTYLE', H.dimstyleTable, 1, () => o.str(100, 'AcDbDimStyleTable'))
  record(o, 'DIMSTYLE', H.dimstyleStandard, H.dimstyleTable, 'AcDbDimStyleTableRecord', 'Standard')
  o.str(340, H.styleStandard)
  o.str(0, 'ENDTAB')

  table(o, 'BLOCK_RECORD', H.blockRecordTable, 2)
  record(o, 'BLOCK_RECORD', H.modelRecord, H.blockRecordTable, 'AcDbBlockTableRecord', '*Model_Space')
  o.str(340, H.modelLayout)
  record(o, 'BLOCK_RECORD', H.paperRecord, H.blockRecordTable, 'AcDbBlockTableRecord', '*Paper_Space')
  o.str(340, H.paperLayout)
  o.str(0, 'ENDTAB')
  o.str(0, 'ENDSEC')

  o.str(0, 'SECTION')
  o.str(2, 'BLOCKS')
  block(o, H.modelBlock, H.modelEndblk, H.modelRecord, '*Model_Space', false)
  block(o, H.paperBlock, H.paperEndblk, H.paperRecord, '*Paper_Space', true)
  o.str(0, 'ENDSEC')

  o.str(0, 'SECTION')
  o.str(2, 'ENTITIES')
  o.raw(entities.text())
  o.str(0, 'ENDSEC')

  o.str(0, 'SECTION')
  o.str(2, 'OBJECTS')
  o.str(0, 'DICTIONARY')
  o.str(5, H.rootDict)
  o.str(330, '0')
  o.str(100, 'AcDbDictionary')
  o.int(281, 1)
  for (const [name, h] of [['ACAD_GROUP', H.groupDict], ['ACAD_LAYOUT', H.layoutDict], ['ACAD_MLINESTYLE', H.mlineStyleDict], ['ACAD_PLOTSTYLENAME', H.plotStyleDict]] as const) {
    o.str(3, name)
    o.str(350, h)
  }
  const dictionary = (h: string, entries: readonly (readonly [string, string])[], type = 'DICTIONARY'): void => {
    o.str(0, type)
    o.str(5, h)
    reactors(o, H.rootDict)
    o.str(330, H.rootDict)
    o.str(100, 'AcDbDictionary')
    o.int(281, 1)
    for (const [name, target] of entries) {
      o.str(3, name)
      o.str(350, target)
    }
  }
  dictionary(H.groupDict, [])
  dictionary(H.layoutDict, [['Layout1', H.paperLayout], ['Model', H.modelLayout]])
  dictionary(H.mlineStyleDict, [['Standard', H.mlineStyleStandard]])
  dictionary(H.plotStyleDict, [['Normal', H.plotStyleNormal]], 'ACDBDICTIONARYWDFLT')
  o.str(100, 'AcDbDictionaryWithDefault')
  o.str(340, H.plotStyleNormal)
  o.str(0, 'ACDBPLACEHOLDER')
  o.str(5, H.plotStyleNormal)
  reactors(o, H.plotStyleDict)
  o.str(330, H.plotStyleDict)
  layout(o, H.paperLayout, 'Layout1', 1, H.paperRecord, ext)
  layout(o, H.modelLayout, 'Model', 0, H.modelRecord, ext)
  o.str(0, 'MLINESTYLE')
  o.str(5, H.mlineStyleStandard)
  reactors(o, H.mlineStyleDict)
  o.str(330, H.mlineStyleDict)
  o.str(100, 'AcDbMlineStyle')
  o.str(2, 'Standard')
  o.int(70, 0)
  o.str(3, '')
  o.int(62, 256)
  o.real(51, 90)
  o.real(52, 90)
  o.int(71, 2)
  for (const offset of [0.5, -0.5]) {
    o.real(49, offset)
    o.int(62, 256)
    o.str(6, 'BYLAYER')
  }
  o.str(0, 'ENDSEC')
  o.str(0, 'EOF')
}
