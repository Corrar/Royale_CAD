# Royale CAD — Design

Data: 2026-10-13 · Status: aguardando aprovação
Plano: `docs/superpowers/plans/2026-10-13-royale-cad-roadmap.md`

## 1. Escopo

CAD 2D para desktop. Operação igual à do AutoCAD (aliases, prompts sequenciais, coordenadas digitadas, osnap), visual minimalista Royale, milhões de vetores a 60 FPS.

**Fora da v1:** 3D · DWG · DXF binário · paper space e plotagem · criação de cotas e hachuras · linetypes tracejados na tela (aparecem contínuos) · fontes SHX · LISP/scripts · grips · auto-update.

## 2. Decisões

| Tema | Decisão | Por quê |
|---|---|---|
| Stack | Electron + TypeScript `strict` + React + Vite | Chromium fixo = GPU previsível; uma linguagem; Node já instalado |
| GPU | WebGL2, único backend na v1, atrás de `RenderBackend` | Cobertura universal de hardware; WebGPU entra depois sem tocar o resto |
| Algoritmos | Clean-room (ver §12) | Royale CAD fica livre de GPL; menor custo |
| Precisão | `f64` no documento; GPU recebe pares `f32` hi/lo (relative-to-eye) | Coordenadas UTM (~7e6) sem tremor e sem rebase |
| Entidades | Objetos imutáveis; vértices em `Float64Array` | Undo = guardar antes/depois; sem alocador próprio |
| Extensão | Registro `EntityType` (um registro por tipo) | Objeto paramétrico futuro = novo registro, sem mexer em render |
| Índice espacial | R-tree Hilbert empacotado próprio, reconstruído sob demanda + lista de sujos | Milhões de itens em typed arrays; o `flatbush` não cabia no G2 (ver T12) |
| Comandos | Generators (`function*`) que emitem pedidos de entrada | Cada comando é um roteiro linear, testável por script de texto |
| Transiente | Canvas 2D sobreposto (mira, elástico, marcadores) | Poucos itens; dispensa pipeline GL extra |
| Grid | Shader procedural em tela cheia | Zero geometria |
| UI state | `useSyncExternalStore` sobre os stores do app | Sem biblioteca de estado |
| CSS | `tokens.css` com variáveis; sem framework | Seis componentes |
| Testes | Vitest no kernel (Node, sem DOM); `pnpm bench` no render | Kernel é TS puro |

Dependências de runtime: `electron`, `react`, `react-dom`, `lucide-react`, fontes Inter e Geist Mono via `@fontsource` (empacotadas, offline). Nenhuma outra sem revisão.

## 3. Arquitetura

```
electron/main ── janela, diálogos, fs
      │ preload (contextIsolation, IPC validado)
┌─────▼────────────────────────── renderer ───────────────────────────────┐
│ ui/      CommandLine · Toolbar · StatusBar · LayerPanel                  │
│ app/     Controller: InputRouter → Interpreter → Document → Scene        │
│ render/  Scene ─▶ RenderBackend ◀─ WebGL2Backend     Overlay (canvas 2D) │
│ kernel/  geom · entity · Document · SpatialIndex · snap · command · dxf  │
└──────────────────────────────────────────────────────────────────────────┘
ui → app → { render, kernel }      render → kernel      kernel → nada
```

`kernel/` compila com `tsconfig` sem a lib `DOM`: importar `window` ou GPU ali é erro de compilação.

## 4. Render pipeline

```
Document ─ change{added,removed,changed} ─▶ Scene ─ writeBatch ─▶ RenderBackend ─▶ GPU
                                             │  EntityType.primitives(e) → segment | arc
pan/zoom ────────────────────────────────────┴─ frame(view, draws)   só uniforms, zero upload
```

O backend só executa primitivas. Não conhece entidade, layer nem documento.

```ts
interface ViewState { cx: number; cy: number; scale: number; width: number; height: number; dpr: number } // scale = px por unidade
interface Draw { batch: BatchId; first: number; count: number; subdiv?: number }
interface RenderBackend {
  createBatch(kind: 'segment' | 'arc', capacity: number): BatchId
  writeBatch(id: BatchId, first: number, instances: ArrayBufferView): void
  destroyBatch(id: BatchId): void
  setStyleTable(table: Uint32Array): void
  frame(view: ViewState, draws: readonly Draw[]): void   // grid é passo fixo do frame
  resize(width: number, height: number, dpr: number): void
}
```

| Item | Definição |
|---|---|
| `segment` | Quad instanciado, 36 B: `p0` e `p1` em hi/lo (8×f32) + `styleId` (u32) |
| `arc` | Faixa instanciada, 32 B: centro hi/lo (4×f32), `r`, `a0`, `sweep` (f32), `styleId` (u32). Posição avaliada no vertex shader |
| LOD de arco | `Scene` agrupa arcos por faixa de raio (log2), um batch por faixa; `Draw.subdiv` é escolhido por frame conforme o zoom. Sem regen, sem reupload |
| Estilo | Textura de dados indexada por `styleId`: cor, largura em px, visível. Trocar cor ou visibilidade de layer = 1 upload pequeno. `styleId 0` = oculto (slot livre), `1` = realce da seleção, depois um por (layer, cor) |
| Curvas livres | Bézier, spline e elipse viram segmentos na CPU, tolerância por faixa de zoom; refaz só as visíveis |
| Seleção | Batch próprio com as primitivas dos selecionados, desenhado por último |
| Culling | Carga em massa vai para pools em ordem de Hilbert, cortados em ~256 baldes com bbox; `draws` devolve os visíveis e funde vizinhos. Edições pequenas vão para pools abertos até a próxima reconstrução |
| Limite do `f32` | O shader descarta segmento > 4e6 px e arco de raio > 1e6 px; a cena os reemite recortados em `f64` |
| Frame | Sob demanda: flag de sujo + `requestAnimationFrame` |
| Overlay | Canvas 2D por cima: mira, elástico do comando, janela de seleção, marcadores de snap |

Pontos de extensão, todos aditivos:

| Futuro | Encaixe |
|---|---|
| WebGPU | Nova implementação de `RenderBackend` |
| Texto | Nova primitiva `glyph` (M7) |
| Objeto paramétrico | Novo `EntityType`; `primitives()` avalia os parâmetros |
| Scene graph / blocos instanciados | Campo `transform` em `Draw` (M7) |

## 5. Kernel

Unidades: `f64`, ângulos em radianos, sentido anti-horário, Y para cima. Graus só na entrada/saída. Igualdade: `|a−b| ≤ 1e-9 · max(1, |a|, |b|)`.

```ts
type Entity = Line | Circle | Arc | Polyline            // v1; + Ellipse | Spline | Insert | Text | Opaque
interface Base { id: number; layer: number; color?: Color }  // ids: inteiros positivos crescentes, nunca reaproveitados
// Color: ACI 1–255 ou TRUE_COLOR | 0xRRGGBB; ausente = ByLayer. ACI 7 segue o fundo (cor de desenho do tema).

interface EntityType<E extends Entity> {
  type: E['type']
  bbox(e: E): BBox
  primitives(e: E, tol: number, out: PrimSink): void
  distance(e: E, p: Vec2): number
  snapPoints?(e: E, modes: number, out: SnapSink): void   // M4
  transform?(e: E, m: Affine): E                          // M5
  dxf?: { read(pairs: Pair[]): E; write(e: E, out: Pair[]): void }   // M6
}

interface Document {
  get(id: number): Entity | undefined
  entities(): Iterable<Entity>
  transact(label: string, fn: (tx: Tx) => void): void      // tx.add / tx.replace / tx.remove
  undo(): void; redo(): void
  onChange(fn: (c: { added: Entity[]; removed: Entity[]; changed: [Entity, Entity][] }) => void): () => void
  layers: LayerTable                                       // nome, cor, visível, travada
}
```

`geom/`: funções puras.

| Módulo | Conteúdo |
|---|---|
| `vec.ts`, `tol.ts` | Vetores, afim 2D, bbox, tolerância |
| `intersect.ts` | seg×seg, seg×círculo, círculo×círculo; arco = círculo + filtro angular; polilinha = decomposição |
| `curve.ts` | `bulgeToArc`; Bézier (De Casteljau: avaliar, dividir, achatar adaptativo); NURBS (De Boor → achatar) |

## 6. Interpretador de comandos

```
tecla/clique ─▶ InputRouter ─▶ Interpreter ─┬ OCIOSO: token → alias → inicia generator
                                            └ ATIVO:  token/clique → Input → generator.next(input)
generator ─ yield Request{kind, prompt, keywords, preview} ─▶ CommandLine + Overlay
```

```ts
function* line(ctx) {                       // forma de todo comando
  let a = yield ctx.point('Specify first point')
  for (;;) { const b = yield ctx.point('Specify next point', { base: a, keywords: ['Undo', 'Close'] }); … }
}
```

| Entrada | Significado |
|---|---|
| `x,y` | Ponto absoluto |
| `@dx,dy` | Relativo ao último ponto |
| `@d<a` / `d<a` | Polar relativo / absoluto, graus anti-horário |
| `d` | Distância direta na direção do cursor (respeita ORTHO) |
| letras | Alias (ocioso) ou palavra-chave por prefixo (ativo) |
| vazio | Enter: aceita padrão, encerra, ou repete o último comando |

Regras: digitar vai para a linha de comando sem precisar de foco · Espaço = Enter · Esc cancela · clique direito = Enter · separador decimal `.`.

Aliases v1 (tabela em dados, editável em M8): `L` LINE · `C` CIRCLE · `A` ARC · `PL` PLINE · `REC` RECTANG · `E` ERASE · `M` MOVE · `CO`/`CP` COPY · `RO` ROTATE · `MI` MIRROR · `SC` SCALE · `O` OFFSET · `TR` TRIM · `EX` EXTEND · `Z` ZOOM · `P` PAN · `U` UNDO · `REDO` · `LA` LAYER.

Teclas: `F3` osnap · `F7` grid · `F8` ortho · `Ctrl+Z/Y` · `Ctrl+O/S` · `Del` = ERASE.

Seleção: clique; janela esquerda→direita (contido); crossing direita→esquerda (toca); Shift remove; vale antes ou depois do comando.

## 7. Snap

```
cursor ─▶ SpatialIndex.query(abertura) ─▶ EntityType.snapPoints(e, modos) ─▶ mais próximo em px ─▶ ponto + marcador
```

- Abertura em px convertida por `view.scale`.
- M4: END (□), MID (△), CEN (○). CEN vale quando a curva está sob a abertura, como no AutoCAD.
- M5: INT, PER, QUA, NEA, NOD.
- Empate: END > MID > CEN > INT > QUA > PER > NEA.

## 8. DXF

```
arquivo ─▶ decode (codepage) ─▶ tokenizer (par código/valor) ─▶ seções ─┬ conhecido → Entity
                                                                        └ resto → Opaque{ raw: Pair[] }
Document ─▶ writer ─▶ template R2000 + entidades + Opaque reemitido sem alteração
```

| Item | Definição |
|---|---|
| Leitura | DXF ASCII R12 a 2018. `HEADER` (subconjunto), tabela `LAYER`, `LINE`, `CIRCLE`, `ARC`, `LWPOLYLINE`, `POLYLINE`, `POINT`; M7: `ELLIPSE`, `SPLINE`, `INSERT`, `TEXT`, `MTEXT` |
| Bloco opaco | Tudo que não entendemos (`HATCH`, `DIMENSION`, `3DSOLID`, XDATA, `OBJECTS`, `CLASSES`…) fica como pares crus e volta idêntico ao salvar. Não é desenhado |
| Handles | Preservados na leitura; novos a partir de `$HANDSEED` |
| Escrita | Arquivo importado: seções originais + entidades. Arquivo novo: template mínimo AC1015 |
| OCS | Extrusão `(0,0,±1)` tratada; outras → opaco |
| Encoding | `$DWGCODEPAGE` via `TextDecoder`; UTF-8 a partir de AC1021 |
| Thread | Parse em Web Worker |
| Cores | Tabela ACI 1–255 + true color (código 420) |

## 9. UI

Viewport em tela cheia, janela sem moldura, painéis flutuantes: ferramentas (superior esquerdo), layer atual (superior direito), linha de comando (pílula inferior central, expande histórico), status e coordenadas (inferior direito).

| Token | Valor |
|---|---|
| `--bg` | `#1B1D20` |
| `--surface` / `--surface-2` | `#24272B` / `#2C3035` |
| `--border` | `#383C42` |
| `--text` / `--text-muted` | `#E6E8EA` / `#9AA0A6` |
| `--accent` | `#67E8F9` |
| Grid menor / maior | `--accent` a 10% / 25% |
| Desenho padrão (ACI 7) | `#F2F4F5` |
| Marcador de snap | `#FBBF24` |
| Raio / fonte UI / fonte mono | `8px` / Inter / Geist Mono |

Ícones Lucide. Todo botão de ícone tem `aria-label` e dica com o alias. Texto com contraste AA.

## 10. Gates de desempenho

Medidos nesta máquina (AMD Radeon integrada, 1080p). Valores são metas a calibrar no primeiro benchmark.

| Gate | Marco | Meta |
|---|---|---|
| G1 | M1 | 1M segmentos em coordenadas UTM, pan/zoom automático: p95 de frame ≤ 16,7 ms |
| G2 | M2 | 1M entidades: heap ≤ 400 MB, rebuild do índice ≤ 200 ms, pick ≤ 1 ms. Rebuild = o que segue edições; o build a frio da carga é informado à parte |
| G3 | M6 | DXF de 100 MB abre sem travar a UI; ida-e-volta sem perda |

## 11. Incógnitas

| # | Incógnita | Padrão assumido | Resolve em |
|---|---|---|---|
| 1 | WebGL2 segura 1M+ segmentos na GPU integrada? | Sim. Se falhar: culling por batch → caminho `GL_LINES` 1 px → backend WebGPU | G1 |
| 2 | Objetos JS aguentam 2M+ entidades? | Sim. Se falhar: store em typed arrays atrás da mesma API `Document` | G2 |
| 3 | AutoCAD aceita nosso DXF gravado? Há AutoCAD/TrueView para validar? | Validar só com LibreCAD e ODA File Converter | M6 |
| 4 | Royale CAD é proprietário? | Sim; por isso clean-room | antes de M0 |
| 5 | Plataformas | Só Windows x64 testado | antes de M8 |
| 6 | Existe design system Royale (tokens, logo)? | Não; tokens do §9 | antes de M0 |
| 7 | Idioma dos prompts | Inglês, igual ao AutoCAD | antes de M3 |
| 8 | Coordenada digitada sem `@` | Absoluta (linha de comando clássica) | antes de M3 |
| 9 | TRIM | Clássico: `TR⏎⏎` seleciona tudo como aresta | antes de M5 |
| 10 | O que falta para a v1 ser usável: texto, blocos, cotas, hachura, PDF? | Texto e blocos em M7; resto fora | antes de M7 |
| 11 | Assinatura de código do instalador | Sem certificado | M8 |

## 12. Fontes permitidas (clean-room)

Permitido: Autodesk DXF Reference (pública), livros e artigos de geometria computacional, derivação própria.
Proibido: copiar ou portar código do LibreCAD, libdxfrw, FreeCAD ou saída de descompilador.
LibreCAD e ODA File Converter servem só de oráculo: abrir o mesmo arquivo e comparar o resultado.
MCP REA fica fora do caminho crítico; uso pontual apenas para observar comportamento de um binário quando a referência DXF for ambígua.

## 13. Marcos

| Marco | Entrega | Gate |
|---|---|---|
| M0 Fundação | Janela Electron vazia, `pnpm check` verde | — |
| M1 Render | Backend WebGL2, pan/zoom, grid, benchmark | G1 |
| M2 Documento | Entidades, undo, índice espacial, cena, pick | G2 |
| M3 Comandos | Linha de comando, parser, LINE, CIRCLE, ERASE, UNDO, ZOOM | — |
| M4 Precisão | Osnap END/MID/CEN, ORTHO, distância direta | — |
| M5 Edição | Interseções, ARC, PLINE, REC, MOVE, COPY, ROTATE, MIRROR, SCALE, TRIM, EXTEND, OFFSET | — |
| M6 DXF | Leitura, escrita, bloco opaco, layers | G3 |
| M7 Curvas e blocos | Bézier/NURBS, ELLIPSE, SPLINE, INSERT, TEXT | — |
| M8 Carcaça | Barras flutuantes, ajustes, instalador | — |

Cada marco termina em software que roda e é testável sozinho.
