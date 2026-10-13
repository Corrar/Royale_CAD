# Royale CAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CAD 2D desktop com operação de AutoCAD, visual Royale e milhões de vetores a 60 FPS.

**Architecture:** Kernel TypeScript puro (geometria, documento, comandos, DXF) sem DOM. `Scene` traduz entidades em primitivas para um `RenderBackend` que só executa `segment` e `arc` em WebGL2. Comandos são generators dirigidos por um interpretador de texto.

**Tech Stack:** Electron · TypeScript `strict` · React · Vite (electron-vite) · WebGL2 · Vitest · flatbush · lucide-react · pnpm

**Spec:** `docs/superpowers/specs/2026-10-13-royale-cad-design.md`

## Global Constraints

- TypeScript `strict`; `src/kernel/` compila sem a lib `DOM` e não importa nada de fora de `src/kernel/`.
- Dependências de runtime permitidas: `electron`, `react`, `react-dom`, `flatbush`, `lucide-react`, `@fontsource*` (Inter, Geist Mono). Qualquer outra exige revisão.
- Clean-room: proibido copiar ou portar código do LibreCAD, libdxfrw, FreeCAD ou saída de descompilador. Fontes: Autodesk DXF Reference, literatura, derivação própria.
- Kernel: `f64`, radianos, anti-horário, Y para cima. Igualdade `|a−b| ≤ 1e-9 · max(1, |a|, |b|)`.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; todo argumento de IPC validado no main.
- Kernel é TDD: teste falhando → implementação mínima → verde. Testes ao lado do fonte (`*.test.ts`).
- Um commit por tarefa. `pnpm check` (`tsc -b` + `vitest run`) verde antes de cada commit.
- Este plano não traz código de implementação (pedido do usuário). Antes de executar um marco, expandir as tarefas dele em passos TDD.
- Argumentos extras de scripts pnpm vão sem `--` (`pnpm smoke --shot=<png>`): o pnpm repassa o `--` literal e o Electron ignora os switches depois dele.
- O kernel não enxerga `console`, `TextDecoder`, `performance` nem `structuredClone` (sem lib `DOM` e sem tipos do Node). O que precisar disso fica fora do kernel ou é injetado.
- Todo modo de execução automática do Electron (`--smoke`, `--bench`) sai por uma função única e idempotente: a primeira chamada define o código de saída.

## Estrutura de arquivos

```
electron/            main.ts · preload.ts
src/kernel/
  geom/              vec.ts · tol.ts · intersect.ts · curve.ts
  entity/            types.ts · registry.ts · line.ts · circle.ts · arc.ts · polyline.ts
  view.ts            ViewState e matemática de pan/zoom
  document.ts        Document, transações, undo, layers
  spatial.ts         SpatialIndex
  pick.ts · selection.ts · snap.ts
  command/           parser.ts · aliases.ts · runtime.ts · commands/*.ts
  dxf/               tokenizer.ts · reader.ts · writer.ts · template.ts · aci.ts
src/render/          backend.ts · hilo.ts · scene.ts · overlay.ts · webgl2/{backend,shaders}.ts
src/app/             controller.ts · input.ts · stores.ts · bench.ts
src/ui/              App.tsx · CommandLine.tsx · Toolbar.tsx · StatusBar.tsx · LayerPanel.tsx · tokens.css
```

---

## M0 — Fundação

- [ ] **T01 · Scaffold**
  - Arquivos: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `src/kernel/tsconfig.json`, `electron/main.ts`, `electron/preload.ts`, `.gitignore`
  - Produz: `git init`; scripts `dev`, `check`, `build`; kernel sem lib `DOM`; flags de segurança do Electron.
  - Verifica: `pnpm check` verde; `pnpm dev` abre janela; arquivo de kernel usando `document` falha no `tsc`.

- [ ] **T02 · Tokens e casca vazia**
  - Arquivos: `src/ui/tokens.css`, `src/ui/App.tsx`
  - Produz: variáveis do §9 da spec; fontes empacotadas; `<canvas id="viewport">` em tela cheia; janela sem moldura com área de arraste.
  - Verifica: janela grafite `#1B1D20`; fontes carregam com a rede desligada.

## M1 — Render (gate G1)

- [ ] **T03 · ViewState**
  - Arquivos: `src/kernel/geom/vec.ts`, `src/kernel/view.ts`, `src/kernel/view.test.ts`, `package.json` (remove `--passWithNoTests` do script `check`: este é o primeiro teste)
  - Produz: `Vec2 {x,y}`, `BBox {minX,minY,maxX,maxY}`; `worldToScreen(v,x,y)`, `screenToWorld(v,sx,sy)`, `zoomAt(v,sx,sy,factor)`, `panBy(v,dxPx,dyPx)`, `fit(v,bbox,marginPx)`; todos retornam novo `ViewState`.
  - Testa: ida-e-volta tela↔mundo; `zoomAt` mantém o ponto sob o cursor com erro < 1e-6 em `(7.4e6, 9.1e6)`; `fit` enquadra o bbox com margem.

- [ ] **T04 · Divisão hi/lo**
  - Arquivos: `src/render/hilo.ts`, `src/render/hilo.test.ts`
  - Produz: `splitDouble(x: number, out: Float32Array, i: number): void` (hi em `i`, lo em `i+1`).
  - Testa: com `Math.fround`, `(hi−eyeHi)+(lo−eyeLo)` difere do valor `f64` em < 1e-6 para `x = 7_400_000.001`.

- [ ] **T05 · Contrato e backend de segmentos**
  - Arquivos: `src/render/backend.ts`, `src/render/webgl2/backend.ts`, `src/render/webgl2/shaders.ts`
  - Consome: `ViewState`, `splitDouble`.
  - Produz: `RenderBackend`, `Draw`, `BatchId` conforme §4 da spec; `SEGMENT_STRIDE = 36`, `ARC_STRIDE = 32`; `createWebGL2Backend(canvas): RenderBackend`; tabela de estilos em textura.
  - Verifica: cena fixa de 3 segmentos em UTM aparece nítida; perda de contexto WebGL recria os recursos.

- [ ] **T06 · Pan e zoom**
  - Arquivos: `src/app/input.ts`, `src/app/controller.ts`
  - Produz: roda = `zoomAt` no cursor; botão do meio = pan; duplo clique do meio = `fit`; frame sob demanda (flag de sujo + rAF); `resize` com DPR.
  - Verifica: ponto sob o cursor não desliza ao dar zoom; CPU em repouso ≈ 0%.
  - Nota: os 32 px do topo do canvas são área de arraste da janela (`HTCAPTION`); eventos de ponteiro não chegam ali.

- [ ] **T07 · Grid procedural**
  - Arquivos: `src/render/webgl2/shaders.ts`, `src/render/webgl2/backend.ts`
  - Produz: grid menor/maior em passos ×10 com fade, cores dos tokens, dentro de `frame`.
  - Verifica: sem cintilação nem moiré do zoom mínimo ao máximo.

- [ ] **T08 · Primitiva arco**
  - Arquivos: `src/render/webgl2/shaders.ts`, `src/render/webgl2/backend.ts`
  - Produz: batch `arc` avaliado no vertex shader; `Draw.subdiv` define as subdivisões da chamada.
  - Verifica: círculos redondos em qualquer zoom; arco de 90° começa e termina nos ângulos certos.

- [ ] **T09 · Benchmark e gate G1**
  - Arquivos: `src/app/bench.ts`, `package.json` (script `bench`)
  - Produz: `pnpm bench --n=1000000` gera segmentos aleatórios em UTM, roda 300 frames de pan/zoom, imprime p50/p95 em JSON e sai com código ≠ 0 se p95 > 16,7 ms.
  - Nota: o intervalo entre `requestAnimationFrame` fica preso ao vsync (~16,7 ms) e tornaria o gate um cara-ou-coroa. Decidir na expansão: medir o custo de render ou desligar o limite de quadros antes de `app.whenReady()`.
  - Verifica: G1. **Parada para decisão do usuário** se falhar (ver incógnita 1).

## M2 — Documento (gate G2)

- [ ] **T10 · Entidades e registro**
  - Arquivos: `src/kernel/geom/tol.ts`, `src/kernel/geom/curve.ts`, `src/kernel/entity/{types,registry,line,circle,arc,polyline}.ts` + testes
  - Produz: `Entity`, `Line`, `Circle`, `Arc`, `Polyline`, `EntityType` (§5); `register(t)`, `typeOf(e)`; `bulgeToArc(a,b,bulge)`; `bbox`, `primitives`, `distance` por tipo.
  - Testa: bbox de arco que cruza 0°; polilinha com bulge 1 vira semicírculo; `distance` a segmento além das pontas.

- [ ] **T11 · Document**
  - Arquivos: `src/kernel/document.ts`, `src/kernel/document.test.ts`
  - Produz: `createDocument(): Document` (§5); `LayerTable` com layer `0`.
  - Testa: um evento por transação; `undo` devolve os mesmos objetos; nova transação limpa o redo; exceção dentro de `transact` não altera nada.

- [ ] **T12 · SpatialIndex**
  - Arquivos: `src/kernel/spatial.ts`, `src/kernel/spatial.test.ts`
  - Consome: `Document.onChange`, `typeOf(e).bbox`.
  - Produz: `createSpatialIndex(doc): { query(b: BBox): number[] }`.
  - Testa: igual à força bruta em 10 mil entidades aleatórias, antes e depois de adicionar e remover sem rebuild.

- [ ] **T13 · Scene**
  - Arquivos: `src/render/scene.ts`, `src/render/scene.test.ts`
  - Consome: `Document`, `RenderBackend`, `EntityType.primitives`.
  - Produz: `createScene(doc, backend): { draws(view: ViewState): Draw[] }`; slots com lista livre; arcos por faixa de raio; estilos por layer.
  - Testa (backend falso que grava chamadas): adicionar = 1 escrita; remover libera o slot; mudar cor do layer só chama `setStyleTable`.

- [ ] **T14 · Pick, seleção e gate G2**
  - Arquivos: `src/kernel/pick.ts`, `src/kernel/selection.ts` + testes; `src/render/scene.ts`; `src/app/bench.ts`
  - Produz: `pick(doc, index, p: Vec2, tol: number): number | null`; `pickBox(doc, index, b: BBox, crossing: boolean): number[]`; `createSelection()` com `ids`, `set`, `add`, `remove`, `clear`, `onChange`; batch de realce.
  - Testa: escolhe o mais próximo entre sobrepostos; janela exige contido, crossing aceita toque.
  - Verifica: G2 no `pnpm bench`. **Parada para decisão do usuário** se falhar (incógnita 2).

## M3 — Comandos

- [ ] **T15 · Parser de entrada**
  - Arquivos: `src/kernel/command/parser.ts`, `parser.test.ts`
  - Produz: `parseInput(text): Token`; `Token = point{mode:'abs'|'rel', x, y} | number{value} | word{text} | empty | invalid`.
  - Testa (tabela, ≥ 20 casos): `10,20` · `@5,0` · `@10<45` · `10<90` · `5` · `-2.5` · vazio · `c` · ` 1.5 , 2 ` · `1,,2` inválido · `@` sozinho inválido.

- [ ] **T16 · Runtime de comandos**
  - Arquivos: `src/kernel/command/runtime.ts`, `aliases.ts`, `runtime.test.ts`
  - Produz: `Request`, `Input`, `Command = (ctx) => Generator<Request, void, Input>`; `createInterpreter(doc, selection)` com `feedText(s)`, `feedPoint(p)`, `cancel()`, `request`, `onChange`; `runScript(interp, text)` para testes.
  - Testa: alias resolve; Enter vazio repete o último; Esc encerra sem transação pendente; palavra-chave por prefixo; entrada inválida mantém o pedido.

- [ ] **T17 · LINE e CIRCLE**
  - Arquivos: `src/kernel/command/commands/{line,circle}.ts` + testes
  - Testa por script: `L⏎0,0⏎10,0⏎@0,5⏎C⏎` cria triângulo fechado; `U` dentro do LINE desfaz o último trecho; `C⏎0,0⏎5⏎` e `C⏎0,0⏎D⏎10⏎` dão raio 5; cada comando = 1 passo de undo.

- [ ] **T18 · ERASE, UNDO, REDO, ZOOM, PAN**
  - Arquivos: `src/kernel/command/commands/{erase,undo,zoom}.ts` + testes
  - Produz: pedido `selection` (clique, janela, crossing, Shift remove, pré-seleção).
  - Testa: `E` com pré-seleção apaga direto; `E⏎` + cliques + `⏎` apaga; `U` restaura; `Z⏎E⏎` enquadra a extensão.

- [ ] **T19 · InputRouter e CommandLine**
  - Arquivos: `src/app/input.ts`, `src/app/stores.ts`, `src/ui/CommandLine.tsx`
  - Produz: teclado global alimenta o buffer sem foco; Espaço = Enter; Esc; clique direito = Enter; histórico; atalhos `Ctrl+Z/Y`, `Del`.
  - Verifica: desenhar linha só com teclado; desenhar com `L⏎` + cliques; digitar dentro de campo de texto da UI não vaza para o comando.

- [ ] **T20 · Overlay**
  - Arquivos: `src/render/overlay.ts`
  - Produz: mira com pickbox, elástico de `Request.preview`, retângulo de janela (sólido) e crossing (tracejado).
  - Verifica: elástico acompanha o cursor sem atraso perceptível em relação ao GL.

## M4 — Precisão

- [ ] **T21 · Snap END/MID/CEN**
  - Arquivos: `src/kernel/snap.ts`, `snap.test.ts`; `snapPoints` em `entity/*.ts`
  - Produz: `snap(doc, index, cursor: Vec2, view: ViewState, modes: number): { p: Vec2; mode: number; id: number } | null`.
  - Testa: fora da abertura → `null`; mais próximo em px vence; empate segue a prioridade do §7; CEN dispara com cursor sobre a circunferência; extremos de arco.

- [ ] **T22 · Snap na interação**
  - Arquivos: `src/app/controller.ts`, `src/render/overlay.ts`, `src/ui/StatusBar.tsx`
  - Produz: pedidos `point` recebem o ponto com snap; marcadores □ △ ○; `F3` e `F7`; botões de status com `aria-pressed`.
  - Verifica: linha fecha exatamente no endpoint (coordenadas idênticas no documento).

- [ ] **T23 · ORTHO e distância direta**
  - Arquivos: `src/kernel/command/runtime.ts` + teste; `src/ui/StatusBar.tsx`
  - Produz: `F8`; número sozinho em pedido `point` com `base` = distância na direção do cursor; `@` usa o último ponto; leitura de coordenadas.
  - Testa por script com cursor simulado: `L⏎0,0⏎` cursor em `(3,1)` com ORTHO, `10⏎` → termina em `(10,0)`.

## M5 — Edição

- [ ] **T24 · Interseções**
  - Arquivos: `src/kernel/geom/intersect.ts`, `intersect.test.ts`
  - Produz: `intersect(a: Entity, b: Entity): Vec2[]`.
  - Testa: tangente (1 ponto); paralelas e colineares (0); toque em extremo; arco fora do intervalo angular; propriedade: todo ponto retornado dista < tolerância das duas entidades.

- [ ] **T25 · ARC, PLINE, RECTANG**
  - Arquivos: `commands/{arc,pline,rectang}.ts` + testes
  - Testa por script: arco por 3 pontos passa pelos 3; `PL` com `C` fecha; `REC` gera polilinha fechada de 4 vértices.

- [ ] **T26 · MOVE, COPY, ROTATE, MIRROR, SCALE**
  - Arquivos: `commands/transform.ts` + teste; `transform` em `entity/*.ts`
  - Testa: espelhar arco inverte o sentido e preserva a geometria; rotação de 360° devolve o original dentro da tolerância; COPY múltiplo até Enter.

- [ ] **T27 · TRIM e EXTEND**
  - Arquivos: `commands/{trim,extend}.ts` + testes
  - Testa por script: `TR⏎⏎` + clique remove o trecho entre interseções vizinhas; círculo cortado vira arco; EXTEND leva à aresta mais próxima; sem interseção nada muda.

- [ ] **T28 · OFFSET**
  - Arquivos: `commands/offset.ts` + teste
  - Produz: linha, círculo e arco. Polilinha fica fora (`shortcut:` registrado no código).
  - Testa: lado escolhido pelo ponto; raio resultante ≤ 0 é recusado com mensagem.

- [ ] **T29 · Snaps INT, PER, QUA, NEA, NOD**
  - Arquivos: `src/kernel/snap.ts` + teste
  - Testa: INT entre linha e círculo; PER relativo ao `base` do pedido; QUA nos 4 quadrantes.

## M6 — DXF (gate G3)

- [ ] **T30 · Tokenizer**
  - Arquivos: `src/kernel/dxf/tokenizer.ts` + teste
  - Produz: `Pair = { code: number; value: string }`; `tokenize(text): Pair[]`; `sections(pairs)`. A decodificação de bytes fica no T33, fora do kernel.
  - Testa: CRLF e LF; espaços no código; arquivo truncado gera erro com número da linha.

- [ ] **T31 · Reader**
  - Arquivos: `src/kernel/dxf/{reader,aci}.ts` + teste; `dxf.read` em `entity/*.ts`; `entity/opaque.ts`
  - Produz: `readDxf(pairs): Document`; `Opaque { type:'opaque'; raw: Pair[] }`; handles preservados.
  - Testa (fixtures escritas à mão): cada entidade suportada; bulge; extrusão `(0,0,-1)` espelha; `HATCH` vira `Opaque`.

- [ ] **T32 · Writer**
  - Arquivos: `src/kernel/dxf/{writer,template}.ts` + teste
  - Produz: `writeDxf(doc): string`.
  - Testa: ler → gravar → ler dá documento igual; pares de `Opaque` idênticos; handles novos > `$HANDSEED` e sem duplicata.

- [ ] **T33 · Arquivos**
  - Arquivos: `electron/main.ts`, `electron/preload.ts`, `src/app/files.ts`, `src/app/dxf.worker.ts`, `commands/file.ts`
  - Produz: OPEN, SAVE, SAVEAS, NEW; `Ctrl+O/S`; parse no Worker com progresso; gravação atômica (arquivo temporário + rename); aviso de alterações não salvas ao fechar.
  - Produz também: `decode(bytes, codepage)` com `TextDecoder` no Worker (`ANSI_1252` com acentos entra nos testes daqui); `setPermissionRequestHandler` negando tudo; validação do remetente em cada handler de IPC.
  - Verifica: fechar com alterações pergunta antes; falha de gravação não corrompe o original.

- [ ] **T34 · Layers e gate G3**
  - Arquivos: `src/ui/LayerPanel.tsx`, `commands/layer.ts`
  - Produz: lista, cor, visibilidade, layer atual; `LA`.
  - Verifica: G3; arquivo gravado abre no LibreCAD e no ODA File Converter sem erro.

## M7 — Curvas e blocos

- [ ] **T35 · Bézier e NURBS**
  - Arquivos: `src/kernel/geom/curve.ts` + teste
  - Produz: `bezierEval`, `bezierSplit`, `bezierFlatten(ctrl, tol)`, `nurbsEval`, `nurbsFlatten(spline, tol)`.
  - Testa: erro do achatamento ≤ `tol` por amostragem; círculo NURBS racional mantém o raio.

- [ ] **T36 · ELLIPSE e SPLINE**
  - Arquivos: `entity/{ellipse,spline}.ts` + testes
  - Produz: leitura, desenho (achatado por faixa de zoom), snaps END, gravação DXF. Sem comando de criação.

- [ ] **T37 · BLOCK e INSERT**
  - Arquivos: `entity/insert.ts`, `src/kernel/dxf/reader.ts`, `src/render/backend.ts` (`Draw.transform`)
  - Testa: bloco aninhado com escala e rotação cai nas coordenadas esperadas; ida-e-volta DXF.

- [ ] **T38 · TEXT e MTEXT**
  - Arquivos: `entity/text.ts`, `src/render/webgl2/*` (primitiva `glyph`)
  - Produz: atlas de glifos; MTEXT com códigos de formatação removidos.
  - Verifica: texto legível de 6 px a zoom extremo; alinhamento confere com o LibreCAD.

## M8 — Carcaça

- [ ] **T39 · Barras flutuantes**
  - Arquivos: `src/ui/Toolbar.tsx`, `src/ui/App.tsx`
  - Verifica: todo botão tem `aria-label`, dica com alias e foco visível; navegação por Tab; contraste AA.

- [ ] **T40 · Ajustes**
  - Arquivos: `src/app/settings.ts`, `src/ui/Settings.tsx`
  - Produz: tabela de aliases e modos de osnap em JSON no `userData`; JSON inválido volta ao padrão com aviso.

- [ ] **T41 · Instalador**
  - Arquivos: `electron-builder.yml`, ícone
  - Verifica: instalador NSIS x64 instala, abre, grava e desinstala em máquina limpa.
  - Decidir: `--smoke`, `--shot` e `--bench` funcionam no build empacotado e `--shot` grava PNG em qualquer caminho; restringir a `!app.isPackaged` ou manter para o teste do instalador.
