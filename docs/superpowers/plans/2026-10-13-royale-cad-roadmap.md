# Royale CAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CAD 2D desktop com operação de AutoCAD, visual Royale e milhões de vetores a 60 FPS.

**Architecture:** Kernel TypeScript puro (geometria, documento, comandos, DXF) sem DOM. `Scene` traduz entidades em primitivas para um `RenderBackend` que só executa `segment` e `arc` em WebGL2. Comandos são generators dirigidos por um interpretador de texto.

**Tech Stack:** Electron · TypeScript `strict` · React · Vite (electron-vite) · WebGL2 · Vitest · lucide-react · pnpm

**Spec:** `docs/superpowers/specs/2026-10-13-royale-cad-design.md`

## Global Constraints

- TypeScript `strict`; `src/kernel/` compila sem a lib `DOM` e não importa nada de fora de `src/kernel/`.
- Dependências de runtime permitidas: `electron`, `react`, `react-dom`, `lucide-react`, `@fontsource*` (Inter, Geist Mono). Qualquer outra exige revisão. (O `flatbush` saiu no T12: ver o resultado lá.)
- Clean-room: proibido copiar ou portar código do LibreCAD, libdxfrw, FreeCAD ou saída de descompilador. Fontes: Autodesk DXF Reference, literatura, derivação própria.
- Kernel: `f64`, radianos, anti-horário, Y para cima. Igualdade `|a−b| ≤ 1e-9 · max(1, |a|, |b|)`.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; todo argumento de IPC validado no main.
- Kernel é TDD: teste falhando → implementação mínima → verde. Testes ao lado do fonte (`*.test.ts`).
- Um commit por tarefa. `pnpm check` (`tsc -b` + `vitest run`) verde antes de cada commit.
- Este plano não traz código de implementação (pedido do usuário). Antes de executar um marco, expandir as tarefas dele em passos TDD.
- Argumentos extras de scripts pnpm vão sem `--` (`pnpm smoke --shot=<png>`): o pnpm repassa o `--` literal e o Electron ignora os switches depois dele.
- O kernel não enxerga `console`, `TextDecoder`, `performance` nem `structuredClone` (sem lib `DOM` e sem tipos do Node). O que precisar disso fica fora do kernel ou é injetado.
- Todo modo de execução automática do Electron (`--smoke`, `--bench`) sai por uma função única e idempotente: a primeira chamada define o código de saída.
- Verificação visual só pela captura do próprio app (`--shot`), com entrada injetada por `--play`. Nunca capturar a tela do sistema.
- Tempo de GPU só se mede com sincronização (`readPixels`); um número que não cresce com a carga não é medida.
- Em caminho quente com milhões de itens, nada de alocar arrays grandes a cada passada: reaproveitar buffers. Memória nova custa page fault e, com um heap grande, dispara coleta completa.
- O que o benchmark precisa manter vivo vai para uma propriedade global: o minificador apaga variável de módulo que nunca é lida.

## Estrutura de arquivos

```
electron/            main.ts · preload.ts
src/kernel/
  geom/              vec.ts · tol.ts · intersect.ts · curve.ts · clip.ts · hilbert.ts
  entity/            types.ts · registry.ts · line.ts · circle.ts · arc.ts · polyline.ts
  color.ts           Color (ACI ou true color) e tabela ACI
  view.ts            ViewState e matemática de pan/zoom
  document.ts        Document, transações, undo, layers
  spatial.ts         SpatialIndex (R-tree Hilbert empacotado)
  pick.ts · selection.ts · snap.ts
  command/           parser.ts · aliases.ts · runtime.ts · commands/*.ts
  dxf/               tokenizer.ts · reader.ts · writer.ts · template.ts
src/render/          backend.ts · hilo.ts · grid.ts · scene.ts · overlay.ts · webgl2/{backend,shaders}.ts
src/app/             controller.ts · input.ts · theme.ts · stores.ts · bench.ts
src/ui/              App.tsx · CommandLine.tsx · Toolbar.tsx · StatusBar.tsx · LayerPanel.tsx · tokens.css
```

---

## M0 — Fundação

- [x] **T01 · Scaffold**
  - Arquivos: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `src/kernel/tsconfig.json`, `electron/main.ts`, `electron/preload.ts`, `.gitignore`
  - Produz: `git init`; scripts `dev`, `check`, `build`; kernel sem lib `DOM`; flags de segurança do Electron.
  - Verifica: `pnpm check` verde; `pnpm dev` abre janela; arquivo de kernel usando `document` falha no `tsc`.

- [x] **T02 · Tokens e casca vazia**
  - Arquivos: `src/ui/tokens.css`, `src/ui/App.tsx`
  - Produz: variáveis do §9 da spec; fontes empacotadas; `<canvas id="viewport">` em tela cheia; janela sem moldura com área de arraste.
  - Verifica: janela grafite `#1B1D20`; fontes carregam com a rede desligada.

## M1 — Render (gate G1)

- [x] **T03 · ViewState**
  - Arquivos: `src/kernel/geom/vec.ts`, `src/kernel/view.ts`, `src/kernel/view.test.ts`, `package.json` (remove `--passWithNoTests` do script `check`: este é o primeiro teste)
  - Produz: `Vec2 {x,y}`, `BBox {minX,minY,maxX,maxY}`; `worldToScreen(v,x,y)`, `screenToWorld(v,sx,sy)`, `zoomAt(v,sx,sy,factor)`, `panBy(v,dxPx,dyPx)`, `fit(v,bbox,marginPx)`; todos retornam novo `ViewState`.
  - Testa: ida-e-volta tela↔mundo; `zoomAt` mantém o ponto sob o cursor com erro < 1e-6 em `(7.4e6, 9.1e6)`; `fit` enquadra o bbox com margem.

- [x] **T04 · Divisão hi/lo**
  - Arquivos: `src/render/hilo.ts`, `src/render/hilo.test.ts`
  - Produz: `splitDouble(x: number, out: Float32Array, i: number): void` (hi em `i`, lo em `i+1`).
  - Testa: com `Math.fround`, `(hi−eyeHi)+(lo−eyeLo)` difere do valor `f64` em < 1e-6 para `x = 7_400_000.001`.

- [x] **T05 · Contrato e backend de segmentos**
  - Arquivos: `src/render/backend.ts`, `src/render/webgl2/backend.ts`, `src/render/webgl2/shaders.ts`
  - Consome: `ViewState`, `splitDouble`.
  - Produz: `RenderBackend`, `Draw`, `BatchId` conforme §4 da spec; `SEGMENT_STRIDE = 36`, `ARC_STRIDE = 32`; `createWebGL2Backend(canvas): RenderBackend`; tabela de estilos em textura.
  - Verifica: cena fixa de 3 segmentos em UTM aparece nítida; perda de contexto WebGL recria os recursos.

- [x] **T06 · Pan e zoom**
  - Arquivos: `src/app/input.ts`, `src/app/controller.ts`
  - Produz: roda = `zoomAt` no cursor; botão do meio = pan; duplo clique do meio = `fit`; frame sob demanda (flag de sujo + rAF); `resize` com DPR.
  - Verifica: ponto sob o cursor não desliza ao dar zoom; CPU em repouso ≈ 0%.
  - Nota: os 32 px do topo do canvas são área de arraste da janela (`HTCAPTION`); eventos de ponteiro não chegam ali.

- [x] **T07 · Grid procedural**
  - Arquivos: `src/render/webgl2/shaders.ts`, `src/render/webgl2/backend.ts`
  - Produz: grid menor/maior em passos ×10 com fade, cores dos tokens, dentro de `frame`.
  - Verifica: sem cintilação nem moiré do zoom mínimo ao máximo.

- [x] **T08 · Primitiva arco**
  - Arquivos: `src/render/webgl2/shaders.ts`, `src/render/webgl2/backend.ts`
  - Produz: batch `arc` avaliado no vertex shader; `Draw.subdiv` define as subdivisões da chamada.
  - Verifica: círculos redondos em qualquer zoom; arco de 90° começa e termina nos ângulos certos.

- [x] **T09 · Benchmark e gate G1**
  - Arquivos: `src/app/bench.ts`, `package.json` (script `bench`)
  - Produz: `pnpm bench --n=1000000` gera segmentos aleatórios em UTM, roda 300 frames de pan/zoom, imprime p50/p95 em JSON e sai com código ≠ 0 se p95 > 16,7 ms.
  - Método: a amostra é o tempo de render do frame com a GPU sincronizada (`backend.frame` + `gl.readPixels` de 1 pixel), com vsync ligado. Desligar o limite de quadros não serve: o laço deixa de esperar a GPU.
  - Verifica: G1. **Parada para decisão do usuário** se falhar (ver incógnita 1).
  - Resultado (2026-10-13, Radeon integrada 0x1638, 1920×1080): **G1 falha.** 1M segmentos: p50 ≈ 22 ms, p95 ≈ 47 ms; zoom ≥ 10×: ≈ 14 ms; tudo visível: ≈ 42 ms. Diagnóstico descartável: sem MSAA o p95 cai para ≈ 20 ms; linhas de hardware de 1 px sem MSAA, ≈ 17,4 ms.

- [x] **T09b · Tema injetado e testes do backend**
  - Arquivos: `src/render/webgl2/backend.ts`, `src/render/webgl2/backend.test.ts`, `src/app/controller.ts`, `src/app/bench.ts`
  - Produz: `createWebGL2Backend(canvas, { bg, gridMinor, gridMajor })`; a leitura dos tokens CSS sai do backend e vai para `src/app/`; a cor de desenho da demo usa o mesmo leitor.
  - Testa (GL falso por `Proxy`): caminhos de `RangeError`; a restauração reenvia todo batch vivo e pula os destruídos; `frame` com contexto perdido registra e não desenha.
  - Nota: vem antes de qualquer otimização do backend.
  - Feito: `src/app/theme.ts` lê os tokens (`readBackendTheme`, `packRgba`); `createWebGL2Backend(canvas, theme)`.

## M2 — Documento (gate G2)

- [x] **T10 · Entidades e registro**
  - Arquivos: `src/kernel/geom/tol.ts`, `src/kernel/geom/curve.ts`, `src/kernel/entity/{types,registry,line,circle,arc,polyline}.ts` + testes
  - Produz: `Entity`, `Line`, `Circle`, `Arc`, `Polyline`, `EntityType` (§5); `register(t)`, `typeOf(e)`; `bulgeToArc(a,b,bulge)`; `bbox`, `primitives`, `distance` por tipo.
  - Testa: bbox de arco que cruza 0°; polilinha com bulge 1 vira semicírculo; `distance` a segmento além das pontas.
  - Decisões: geometria de tamanho fixo em campos numéricos (`Line {x0,y0,x1,y1}`, `Arc {cx,cy,r,a0,a1}` anti-horário de `a0` a `a1`); `Float64Array` só nas listas de vértices (`Polyline.pts`, `bulges`). Um `Float64Array` por linha custaria mais memória que os campos. `EntityType.validate?` opcional rejeita raio ≤ 0 e polilinha malformada.
  - Cor (`src/kernel/color.ts`): ACI 1–255 ou `TRUE_COLOR | 0xRRGGBB`; ausente = ByLayer. A tabela ACI 10–249 sai do padrão de matiz/valor; o T31 confere contra LibreCAD/ODA.

- [x] **T11 · Document**
  - Arquivos: `src/kernel/document.ts`, `src/kernel/document.test.ts`
  - Produz: `createDocument(): Document` (§5); `LayerTable` com layer `0`.
  - Testa: um evento por transação; `undo` devolve os mesmos objetos; nova transação limpa o redo; exceção dentro de `transact` não altera nada.
  - Contrato: ids inteiros positivos crescentes, nunca reaproveitados (o índice e a cena indexam arrays densos por id). `entities()` em ordem de inserção; desfazer uma remoção põe a entidade no fim. `undo()`/`redo()` devolvem o rótulo do passo.
  - Fica para depois: mudanças na `LayerTable` não entram no undo (T34).

- [x] **T12 · SpatialIndex**
  - Arquivos: `src/kernel/spatial.ts`, `src/kernel/spatial.test.ts`
  - Consome: `Document.onChange`, `typeOf(e).bbox`.
  - Produz: `createSpatialIndex(doc): { query(b: BBox): number[] }`.
  - Testa: igual à força bruta em 10 mil entidades aleatórias, antes e depois de adicionar e remover sem rebuild.
  - Resultado: o `flatbush` saiu. O `finish()` dele leva ~230 ms para 1M itens nesta VM (a ordenação troca 4 f64 por movimento) e não aproveita entrada quase ordenada. No lugar, R-tree Hilbert empacotado próprio (`geom/hilbert.ts`: chave por tabela + radix sort), bbox em cache denso por id e duas reconstruções. A frio ordena tudo. Depois de edições, intercala os sujos ordenados na ordem antiga e escreve nos arrays da árvore anterior, sem alocar. Mudança maior que ¼ da árvore vai direto para a reconstrução a frio.

- [x] **T13 · Scene**
  - Arquivos: `src/render/scene.ts`, `src/render/scene.test.ts`
  - Consome: `Document`, `RenderBackend`, `EntityType.primitives`.
  - Produz: `createScene(doc, backend): { draws(view: ViewState): Draw[] }`; slots com lista livre; arcos por faixa de raio; estilos por layer.
  - Testa (backend falso que grava chamadas): adicionar = 1 escrita; remover libera o slot; mudar cor do layer só chama `setStyleTable`.
  - Notas da revisão do M1:
    - Batches por célula espacial, para `draws(view)` devolver só os visíveis (culling). Lista livre global destrói a localidade. Manter os batches visíveis na casa das centenas.
    - `styleId 0` reservado como oculto: um slot zerado é um ponto visível em (0,0).
    - Carga em massa junta as escritas: um DXF não pode virar um milhão de `writeBatch`.
    - Primitiva cuja extensão na tela passe de ~4e6 px de dispositivo (segmento ou arco) é reemitida recortada em `f64`: além disso o `f32` do shader desloca o traço, engrossa e por fim some.
  - Feito: carga em massa vai para pools empacotados em ordem de Hilbert, cortados em ~256 baldes de culling; baldes vizinhos visíveis viram um só draw (extensão inteira = 1 draw). Edições pequenas vão para pools abertos (lista livre, crescem dobrando). Arcos por faixa `floor(log2 r)`. O shader descarta segmento > `MAX_SEGMENT_PX` (4e6) e arco de raio > `MAX_ARC_RADIUS_PX` (1e6); a cena reemite em `f64`, recortado na vista (`geom/clip.ts`), o que passa de metade disso.
  - Medido (1M linhas, Node, backend falso): `draws()` 0,02–0,06 ms por frame; zoom máximo 0,7 ms. Construção da cena ~1 s, uma vez por carga.
  - Fica para depois: a ordem de desenho é espacial, não a de criação (DRAWORDER).
  - Contrato `RenderBackend.onRestore`: depois de perder o contexto, os batches voltam zerados com a mesma capacidade e o dono reescreve (a cena marca todos os pools; o controller pede frame). A tabela de estilos é textura 2D em linhas de até 1024 estilos e é recriada a cada reconstrução da cena.

- [x] **T14 · Pick, seleção e gate G2**
  - Arquivos: `src/kernel/pick.ts`, `src/kernel/selection.ts` + testes; `src/render/scene.ts`; `src/app/bench.ts`
  - Produz: `pick(doc, index, p: Vec2, tol: number): number | null`; `pickBox(doc, index, b: BBox, crossing: boolean): number[]`; `createSelection()` com `ids`, `set`, `add`, `remove`, `clear`, `onChange`; batch de realce.
  - Testa: escolhe o mais próximo entre sobrepostos; janela exige contido, crossing aceita toque.
  - Verifica: G2 no `pnpm bench`. **Parada para decisão do usuário** se falhar (incógnita 2).
  - Nota: a validação do resultado em `electron/main.ts` é específica do G1 (`frames === 300`, código de saída pelo `p95`); o G2 precisa da própria.
  - Feito: `pnpm bench:g2` (`--gate=g2`) mede 1M entidades (85% linhas, 5% círculos, 5% arcos, 5% polilinhas) com documento, índice e cena vivos. Memória: o processo principal força GC e lê `Runtime.getHeapUsage` pelo DevTools; o gate soma o heap do V8 (`usedSize`) e os ArrayBuffers (`backingStorageSize`), que o heap sozinho não conta. `performance.memory` não é preciso no Electron. Reconstrução: o maior de 5 rounds que movem 2% do desenho. Pick: p95 de 1000, na vista da extensão inteira. O resultado só vale com ≥ 900 picks acertando, 1 build a frio e 7 reconstruções. O G1 (`pnpm bench`) passa a desenhar por Document + Scene, então o culling conta. Clique seleciona, Shift+clique tira, Esc limpa (provisório até o T19).
  - Resultado (2026-10-16, VM Xeon 2,1 GHz, SwiftShader, sem a máquina-alvo): **G2 passa.** Memória 373 MB (heap 177 + buffers 196); reconstrução após edição 61 ms (p50), 66 ms (máx.); pick p95 0,4 ms. Só informativo: carga 1,2 s; índice a frio 0,2 s; cena 0,7 s. Pela medida antiga (só heap) a mesma carga dava 177 MB e escondia ~300 MB de buffers; para caber, o backend deixou de guardar cópia em CPU dos batches (ver contrato `onRestore`).
  - Revisão do M2 (duas revisões independentes, cada achado reproduzido em teste): corrigidos o spare do índice dividindo arrays com a árvore viva, bulge-ruído virando arco sem pontas, NaN passando pela validação, crossing ignorando contato de um ponto, eventos fora de ordem quando um listener faz transação, tabela de estilos sem limite útil nem reaproveitamento, handles com 2^24 slots e o G2 medindo só o heap.
  - Pendente: rodar `pnpm bench:g2` e `pnpm bench` na máquina-alvo (Radeon 0x1638). O culling só ajuda com zoom; o regime "tudo visível" do G1 (≈ 42 ms) não muda e continua na incógnita 1.

## M3 — Comandos

- [x] **T15 · Parser de entrada**
  - Arquivos: `src/kernel/command/parser.ts`, `parser.test.ts`
  - Produz: `parseInput(text): Token`; `Token = point{mode:'abs'|'rel', x, y} | number{value} | word{text} | empty | invalid`.
  - Testa (tabela, ≥ 20 casos): `10,20` · `@5,0` · `@10<45` · `10<90` · `5` · `-2.5` · vazio · `c` · ` 1.5 , 2 ` · `1,,2` inválido · `@` sozinho inválido.
  - Feito: 36 casos. Ângulos múltiplos de 90° dão coordenadas exatas (`@10<90` → `0,10`). Forma de número nunca vira palavra (`1e999` é inválido); palavra precisa de uma letra (`3P`, `-LAYER`).

- [x] **T16 · Runtime de comandos**
  - Arquivos: `src/kernel/command/runtime.ts`, `aliases.ts`, `runtime.test.ts`
  - Produz: `Request`, `Input`, `Command = (ctx) => Generator<Request, void, Input>`; `createInterpreter(doc, selection)` com `feedText(s)`, `feedPoint(p)`, `cancel()`, `request`, `onChange`; `runScript(interp, text)` para testes.
  - Testa: alias resolve; Enter vazio repete o último; Esc encerra sem transação pendente; palavra-chave por prefixo; entrada inválida mantém o pedido.
  - Feito: pedidos `point` (base → distância direta; `allowEmpty`; `acceptNumber` para o ZOOM; `preview`), `number` (ponto vira distância da base; `default`; `positive`), `keyword` e `selection`. Opção casa exata, depois por prefixo único. `@` parte do LASTPOINT. Histórico ecoa prompt + resposta como o AutoCAD. Helpers `getPoint`, `getNumber`, `getSelection`; `commandBench()` em `testing.ts` para os testes.
  - Document ganhou grupos de undo (`beginGroup`/`endGroup`): o interpretador abre um por comando (exceto os marcados `noUndoGroup`: U, UNDO, REDO, ZOOM, PAN). Cada trecho do LINE é uma transação e aparece na hora; no fim, o comando vira um passo só. Dentro do grupo o undo não passa do início do comando.

- [x] **T17 · LINE e CIRCLE**
  - Arquivos: `src/kernel/command/commands/{line,circle}.ts` + testes
  - Testa por script: `L⏎0,0⏎10,0⏎@0,5⏎C⏎` cria triângulo fechado; `U` dentro do LINE desfaz o último trecho; `C⏎0,0⏎5⏎` e `C⏎0,0⏎D⏎10⏎` dão raio 5; cada comando = 1 passo de undo.

- [x] **T18 · ERASE, UNDO, REDO, ZOOM, PAN**
  - Arquivos: `src/kernel/command/commands/{erase,undo,view}.ts` + testes
  - Produz: pedido `selection` (clique, janela, crossing, Shift remove, pré-seleção).
  - Testa: `E` com pré-seleção apaga direto; `E⏎` + cliques + `⏎` apaga; `U` restaura; `Z⏎E⏎` enquadra a extensão.
  - Feito: seleção no prompt e ociosa pelo próprio interpretador (clique, janela/crossing pela ordem dos cantos, Shift tira, `ALL`). A seleção global é o conjunto de trabalho, realçado enquanto se escolhe. ERASE pula layers travados. ZOOM: janela, fator (`n` ou `nX`, relativo à vista), `All`/`Extents` (sem limites, os dois enquadram o desenho). PAN pela linha de comando: deslocamento por dois pontos ou um vetor.
  - T16–T18 foram num commit só: os testes do runtime usam os comandos reais.
  - Fica para depois: ZOOM Previous (precisa de histórico de vistas, inclusive da roda).

- [x] **T19 · InputRouter e CommandLine**
  - Arquivos: `src/app/input.ts`, `src/app/stores.ts`, `src/ui/CommandLine.tsx`
  - Produz: teclado global alimenta o buffer sem foco; Espaço = Enter; Esc; clique direito = Enter; histórico; atalhos `Ctrl+Z/Y`, `Del`.
  - Verifica: desenhar linha só com teclado; desenhar com `L⏎` + cliques; digitar dentro de campo de texto da UI não vaza para o comando.
  - Feito: `attachKeyboard` (Ctrl+Z/Ctrl+Y viram U/REDO só com o comando ocioso; Del vira ERASE com seleção; F2 expande o histórico); botão direito = Enter, sem menu de contexto. Pílula flutuante com 3 linhas de histórico (30 com F2 ou chevron). Verificado por `--play` digitando `L⏎100,100⏎300,100⏎300,250⏎C⏎`. A demo saiu: o app abre vazio numa folha A3.

- [x] **T20 · Overlay**
  - Arquivos: `src/render/overlay.ts`
  - Produz: mira com pickbox, elástico de `Request.preview`, retângulo de janela (sólido) e crossing (tracejado).
  - Verifica: elástico acompanha o cursor sem atraso perceptível em relação ao GL.
  - Feito: Canvas 2D por cima, redesenhado no mesmo frame do GL (a cena GL só quando muda). Mira de 40 px por braço, cursor do sistema escondido no viewport; pickbox quando o clique seleciona; elástico na cor de destaque; janela sólida, crossing tracejado, com preenchimentos novos nos tokens (`--window-fill`, `--crossing-fill`).

## M4 — Precisão

- [x] **T21 · Snap END/MID/CEN**
  - Arquivos: `src/kernel/snap.ts`, `snap.test.ts`; `snapPoints` em `entity/*.ts`
  - Produz: `snap(doc, index, cursor: Vec2, view: ViewState, modes: number): { p: Vec2; mode: number; id: number } | null`.
  - Testa: fora da abertura → `null`; mais próximo em px vence; empate segue a prioridade do §7; CEN dispara com cursor sobre a circunferência; extremos de arco.
  - Feito: `snap(…, modes, aperturePx)` com `APERTURE_PX = 10` (o padrão do AutoCAD); layers ocultos ficam de fora. `snapPoints` por tipo: linha (pontas, meio), círculo (centro), arco (pontas, meio do arco, centro), polilinha (vértices, meio de cada trecho, centro dos trechos curvos).

- [x] **T22 · Snap na interação**
  - Arquivos: `src/app/controller.ts`, `src/render/overlay.ts`, `src/ui/StatusBar.tsx`
  - Produz: pedidos `point` recebem o ponto com snap; marcadores □ △ ○; `F3` e `F7`; botões de status com `aria-pressed`.
  - Verifica: linha fecha exatamente no endpoint (coordenadas idênticas no documento).
  - Nota: `F7` (grid) exige mudança em `src/render/webgl2/backend.ts`: hoje o passo do grid é incondicional e faz também a limpeza do frame.
  - Feito: o interpretador ganha `osnap` (ligado por padrão) e `tracked` (onde o clique cairia e qual snap o pôs lá); só pontos apontados passam pelo snap, nunca os digitados. Backend ganha `setGrid`; sem grid o frame limpa com o fundo. Barra de status com coordenadas do ponto resolvido e GRID/ORTHO/OSNAP com `aria-pressed`.

- [x] **T23 · ORTHO e distância direta**
  - Arquivos: `src/kernel/command/runtime.ts` + teste; `src/ui/StatusBar.tsx`
  - Produz: `F8`; número sozinho em pedido `point` com `base` = distância na direção do cursor; `@` usa o último ponto; leitura de coordenadas.
  - Testa por script com cursor simulado: `L⏎0,0⏎` cursor em `(3,1)` com ORTHO, `10⏎` → termina em `(10,0)`.
  - Feito: o snap vence o ORTHO, como no AutoCAD; a distância direta segue o mesmo ponto resolvido.

## M5 — Edição

- [x] **T24 · Interseções**
  - Arquivos: `src/kernel/geom/intersect.ts`, `intersect.test.ts`
  - Produz: `intersect(a: Entity, b: Entity): Vec2[]`.
  - Testa: tangente (1 ponto); paralelas e colineares (0); toque em extremo; arco fora do intervalo angular; propriedade: todo ponto retornado dista < tolerância das duas entidades.
  - Feito: por primitivas (segmento × segmento, segmento × círculo, círculo × círculo; arco = círculo com filtro angular), a partir de uma origem local para não perder dígitos em UTM. Círculos coincidentes não dão ponto; vértice compartilhado de polilinha não repete. Propriedade: 2000 pares aleatórios, todo ponto a menos de 1e-7 das duas.

- [x] **T25 · ARC, PLINE, RECTANG**
  - Arquivos: `commands/{arc,pline,rectang}.ts` + testes
  - Testa por script: arco por 3 pontos passa pelos 3; `PL` com `C` fecha; `REC` gera polilinha fechada de 4 vértices.
  - Feito: ARC por 3 pontos (colineares pedem de novo) ou `Center`, início e fim; PLINE com `Arc`/`Line` (arco tangente ao trecho anterior), `Close` e `Undo`, e Esc mantém o que foi desenhado, como no AutoCAD; RECTANG recusa retângulo sem área.

- [x] **T26 · MOVE, COPY, ROTATE, MIRROR, SCALE**
  - Arquivos: `commands/transform.ts` + teste; `transform` em `entity/*.ts`
  - Testa: espelhar arco inverte o sentido e preserva a geometria; rotação de 360° devolve o original dentro da tolerância; COPY múltiplo até Enter.
  - Feito: `transform` só para semelhanças (afins em `geom/vec.ts`; múltiplos de 90° exatos). Pré-seleção ou seleção; layers travados ficam de fora com aviso; prévia das entidades sob o cursor (até 500). MOVE com Enter usa o primeiro ponto como deslocamento; ROTATE aceita ângulo ou direção de um ponto; MIRROR pergunta `Erase source objects? [Yes/No] <No>:`.

- [x] **T27 · TRIM e EXTEND**
  - Arquivos: `commands/{trim,extend}.ts` + testes
  - Testa por script: `TR⏎⏎` + clique remove o trecho entre interseções vizinhas; círculo cortado vira arco; EXTEND leva à aresta mais próxima; sem interseção nada muda.
  - Feito: `entity/path.ts` dá a cada tipo um parâmetro (`param`, `slack`, `slice`), e TRIM/EXTEND trabalham sobre ele para todos os tipos: polilinha aberta perde o trecho, a fechada (e o círculo) cortada duas vezes abre entre os cortes; peça curva cortada mantém o círculo (bulge da fração). EXTEND leva a ponta mais próxima do clique em linha, arco e na peça final de polilinha aberta (reta ou arco); fechados são recusados. Enter na seleção = todos os objetos; `Undo` desfaz o último. Pedido de ponto ganha `pick` (sem OSNAP/ORTHO, com pickbox) e o host ganha `query` (índice espacial).

- [x] **T28 · OFFSET**
  - Arquivos: `commands/offset.ts` + teste
  - Produz: linha, círculo e arco. Polilinha fica fora (`shortcut:` registrado no código).
  - Testa: lado escolhido pelo ponto; raio resultante ≤ 0 é recusado com mensagem.
  - Feito: distância por número, por dois pontos ou `Through`; guardada em `OFFSETDIST` e oferecida como padrão (pedido de ponto ganha `default` exibido como `<…>`). Várias cópias por comando, com `Exit` e `Undo`; a origem fica destacada enquanto o lado é pedido.

- [x] **T29 · Snaps INT, PER, QUA, NEA, NOD**
  - Arquivos: `src/kernel/snap.ts` + teste
  - Testa: INT entre linha e círculo; PER relativo ao `base` do pedido; QUA nos 4 quadrantes.
  - Feito: INT entre os objetos sob o cursor (até 32, os mais próximos); PER com o cursor sobre o objeto, pé no próprio objeto (o host repassa o `base` do pedido); QUA por tipo (`arcQuadrants`, exato); NEA só quando nenhum outro modo responde. Empates por arredondamento seguem a prioridade. Marcadores próprios para os oito modos. OSMODE do app: END, MID, CEN, INT, PER.
  - Pendente: NOD não acha nada até a entidade ponto (`POINT`) chegar com o leitor DXF (T31); ela deve emitir seu ponto em `snapPoints` com `SNAP.NOD`.

## M6 — DXF (gate G3)

- [x] **T30 · Tokenizer**
  - Arquivos: `src/kernel/dxf/tokenizer.ts` + teste
  - Produz: `Pair = { code: number; value: string }`; `tokenize(text): Pair[]`; `sections(pairs)`. A decodificação de bytes fica no T33, fora do kernel.
  - Testa: CRLF e LF; espaços no código; arquivo truncado gera erro com número da linha.
  - Feito: `tokenize` devolve `PairList` em vez de `Pair[]`: códigos num `Int16Array` e valores como intervalos do texto, cortados só quando pedidos (`value(i)`; `is(i, code, word)` compara sem alocar; `pair(i)` dá o objeto). Com um objeto por par, 111 MB levavam 5,4 s e 1,36 GB de heap; assim, 0,6 s e ~90 MB de índice. `sections` devolve `{ name, start, end }` (intervalo de pares). Para no `0/EOF`; BOM ignorado; DXF binário recusado; `DxfError` com `line` (par i começa na linha 2i + 1).

- [x] **T31 · Reader**
  - Arquivos: `src/kernel/dxf/reader.ts` + teste; `dxf.read` em `entity/*.ts`; `entity/opaque.ts`; tabela ACI já em `src/kernel/color.ts` (conferir 10–249 aqui)
  - Produz: `readDxf(pairs): Document`; `Opaque { type:'opaque'; raw: Pair[] }`; handles preservados.
  - Testa (fixtures escritas à mão): cada entidade suportada; bulge; extrusão `(0,0,-1)` espelha; `HATCH` vira `Opaque`.
  - Feito: `readDxf(text)` devolve `{ doc, source, warnings }`: o `Document` não carrega dados do DXF; `source` guarda o texto, a quebra de linha, o header, os trechos de cada seção e, por id lido, a entidade original e o trecho de texto (o writer regrava sem mudança o que não foi editado, e `handleOf(id)` lê o handle de lá: cópias e peças novas não herdam handle). Entidades novas: `Point` (ponto, NOD, desenhado como ponto pelo segmento de comprimento zero) e `Opaque` com `raw: string` (o texto exato, VERTEX/ATTRIB/SEQEND incluídos) em vez de `Pair[]`, pela memória. Entidade sem geometria tem bbox vazia: o documento aceita, o índice, as extensões e a seleção a ignoram (ERASE ALL não apaga o que não se vê). Espaço papel, extrusão inclinada, POLYLINE 3D/malha e número inválido viram `Opaque` com aviso; ByBlock aparece como 7. `Document.clearHistory()`: a carga não é desfazível. Tabela LAYER: cor, desligado/congelado (oculto), travado, true color; layer sem entrada é criado. Conferido com arquivos do ezdxf (R12, R2000, R2018), inclusive a extrusão espelhada.
  - ACI: duas tabelas circulam. A nossa (fórmula) bate com a do `dxf-parser` em 215 de 255 entradas (as outras diferem em 1 num canal: 152 × 153) e difere da do ezdxf em 197 (níveis 165/127/76/38 contra 204/153/127/76; a do ezdxf tem entradas estranhas, como 129, 139 e 149 iguais). Fica a nossa até conferir com AutoCAD ou ODA (pergunta aberta 3).
  - Medido (1M linhas, ~110 MB, Node): leitura 4,8 s, dos quais tokenizer ~0,45 s, parse ~1,2 s, carga no documento ~1,3 s e o resto GC. Fica para o G3 (T34).

- [x] **T32 · Writer**
  - Arquivos: `src/kernel/dxf/{writer,template}.ts` + teste
  - Produz: `writeDxf(doc): string`.
  - Testa: ler → gravar → ler dá documento igual; pares de `Opaque` idênticos; handles novos > `$HANDSEED` e sem duplicata.
  - Feito: `writeDxf(doc, source?)`. Com a fonte: as seções voltam como lidas (HEADER com `$HANDSEED` novo; TABLES com a tabela LAYER acertada: entrada alterada é corrigida, layer novo ganha entrada); ENTITIES é refeita na ordem do documento: entidade não editada volta com o texto exato, editada tem o próprio registro corrigido (geometria, layer e cor; linetype, lineweight, espessura, reatores e XDATA ficam; OCS espelhado mantido), e a de tipo trocado (círculo aparado vira arco) ou nova sai em grupos novos na versão do arquivo (R12 sem marcadores de subclasse e com POLYLINE/VERTEX/SEQEND; R14+ com LWPOLYLINE; true color só de AC1018 em diante, antes a cor ACI mais próxima). Handles novos a partir do maior entre `$HANDSEED` e os handles do arquivo. Sem fonte: arquivo AC1015 novo a partir de `template.ts` (as nove tabelas, blocos e layouts de model e paper space, dicionário raiz). Números com o menor texto que relê o mesmo double.
  - Verificado com o ezdxf: arquivos R12, R2000 e R2018 gravados sem edição voltam byte a byte; editados e o arquivo novo passam pela leitura e pela auditoria do ezdxf sem erro nem correção. LibreCAD e ODA continuam pendentes (pergunta aberta 3).

- [x] **T33 · Arquivos**
  - Arquivos: `electron/main.ts`, `electron/preload.ts`, `src/app/files.ts`, `src/app/dxf.worker.ts`, `commands/file.ts`
  - Produz: OPEN, SAVE, SAVEAS, NEW; `Ctrl+O/S`; parse no Worker com progresso; gravação atômica (arquivo temporário + rename); aviso de alterações não salvas ao fechar.
  - Produz também: `decode(bytes, codepage)` com `TextDecoder` no Worker (`ANSI_1252` com acentos entra nos testes daqui); `setPermissionRequestHandler` negando tudo; validação do remetente em cada handler de IPC.
  - Verifica: fechar com alterações pergunta antes; falha de gravação não corrompe o original.
  - Feito: o leitor se divide em `parseDxf(text, progress)` (dados simples, roda no Worker `dxf.worker.ts` com decodificação e progresso) e `drawingFrom(doc, parsed)`, que usa o novo `Document.replace(layers, drafts)`: o desenho aberto entra no mesmo documento (cena, índice e interpretador seguem ligados), numa mudança só, sem desfazer. Comandos OPEN, NEW, QSAVE (SAVE é alias) e SAVEAS chamam `host.files` depois de perguntar `Save changes to X? [Yes/No/Cancel] <Yes>:` quando há alterações; `Interpreter.print` leva ao histórico o que a operação assíncrona diz. `src/app/files.ts` cuida de nome, sujo, ocupado e da fonte para a ida e volta; `codec.ts` decodifica por `$DWGCODEPAGE` (UTF-8 a partir de AC1021, tabelas de volta para páginas de um e dois bytes, `\U+XXXX` para o que a página não tem). O processo principal (`electron/files.ts`) guarda os caminhos: o renderer só vê nomes e bytes, e um arquivo aberto só vira o do desenho depois de carregado (`adopt`). Gravação atômica (`electron/atomic.ts`: temporário, fsync, rename), pergunta ao fechar com alterações, remetente conferido em cada handler, permissões negadas, `--open=<arquivo>` para os testes de fumaça. Título com nome, ponto de não salvo e progresso; Ctrl+O, Ctrl+S, Ctrl+Shift+S e Ctrl+N.
  - Verificado por `--smoke --open`: o arquivo R2000 do ezdxf abre pelo Worker e aparece; uma linha nova com QSAVE grava no próprio arquivo e o ezdxf o lê e audita sem erro (handle novo, dono model space).
  - Notas: o Node decodifica 0x80–0x9F de windows-1252 diferente do Chromium (o teste usa só acentos). O clone estruturado do resultado do Worker (um objeto por entidade) ainda pesa na thread principal com arquivos grandes: fica para o G3 (T34).

- [x] **T34 · Layers e gate G3**
  - Arquivos: `src/ui/LayerPanel.tsx`, `commands/layer.ts`
  - Produz: lista, cor, visibilidade, layer atual; `LA`.
  - Verifica: G3; arquivo gravado abre no LibreCAD e no ODA File Converter sem erro.
  - Nota do M2: com 1M entidades, a carga no documento (~1,3 s), o índice a frio (~0,8 s) e a cena (~1,6 s) rodam na thread da UI. Para o G3, fatiar ou levar para fora da thread principal.
  - Feito (layers): layer atual (CLAYER) no interpretador, lido do `$CLAYER` ao abrir e gravado ao salvar; entidades novas vão para ele. `-LAYER` (`-LA`) com `?`, Make, Set, New, ON, OFF, Color (número, nome ou r,g,b), Freeze, Thaw, LOck e Unlock, listas de nomes com `*` e `?`; desligar o layer atual pergunta antes. `LAYER` (`LA`) abre o painel (canto superior direito: layer atual, lista com ligar, travar, cor pela paleta ACI, tornar atual, layer novo); sem painel, cai no `-LAYER`. Pedidos de texto (nomes) e opções que terminam com Enter entraram no interpretador.
  - Feito (G3): `pnpm build && electron . --bench --gate=g3 --open=<arquivo>` abre o arquivo no app real depois que ele assentou (500 ms sem frame nem tarefa acima de 50 ms: a partida do app não conta) e mede frames e long tasks até a cena e o índice ficarem prontos, mais 500 ms. Passa com o maior intervalo entre frames ≤ 200 ms. O caminho: o Worker devolve os drafts num `DraftPack` (arrays tipados transferidos, em vez de um objeto por entidade) e os bytes do arquivo em vez do texto (decodificado de novo só ao gravar ou ler um handle), com as extensões já calculadas; o main entrega o arquivo em pedaços de 8 MB (`file:chunk`, cópia, não view); a carga entra em fatias de ~12 ms (`loader` + `Document.append`, mudança marcada `bulk`, sem desfazer); mudança `bulk` não redesenha nem passa pelos pools abertos da cena (um pool aberto não tem culling: desenhava tudo a cada frame); cena (`Scene.build`) e índice (`SpatialIndex.build`, com `sliceFrom`) se reconstroem em tarefas entre os frames, não um pedaço por frame (com GPU lenta um frame custa ~150 ms e o rebuild levava 15 s), e só começam numa chamada sem mudança desde a anterior (antes, cada fatia da carga abortava um rebuild recém-começado e o GPU alocava e soltava dezenas de MB por frame). Enquanto o índice não fica pronto, as consultas varrem o cache de bboxes (exatas, alguns ms). Falha no meio da carga deixa um desenho novo vazio, nunca meio arquivo com o nome antigo; edição feita durante a carga conta como edição; as entidades acham seu texto de origem por faixas de ids por fatia (uma entidade desenhada no meio não desloca as outras); `drawingFrom` segue tudo-ou-nada.
  - Resultado (2026-10-16, VM Xeon 2,1 GHz, SwiftShader; 101 MB, 620 mil entidades): **G3 passa.** Cena e índice prontos em ~4 s (bytes 0,6 s, parse no Worker 1,5 s, carga ~1 s, rebuild ~1 s); maior intervalo entre frames 100–167 ms; nenhuma tarefa na thread principal acima de 50–73 ms. Antes: 2,6 s de UI parada. G2 continua passando (374 MB, rebuild 108 ms, pick p95 0,4 ms). A ida-e-volta sem perda do G3 é a do T32 (byte a byte com o ezdxf).
  - Notas: nesta VM o `pnpm bench` (G1, 1M segmentos todos visíveis) perde o contexto WebGL no SwiftShader, igual no commit anterior; o G1 só vale na máquina-alvo. LibreCAD e ODA continuam pendentes (pergunta aberta 3).

## M7 — Curvas e blocos

- [x] **T35 · Bézier e NURBS**
  - Arquivos: `src/kernel/geom/curve.ts` + teste
  - Produz: `bezierEval`, `bezierSplit`, `bezierFlatten(ctrl, tol)`, `nurbsEval`, `nurbsFlatten(spline, tol)`.
  - Testa: erro do achatamento ≤ `tol` por amostragem; círculo NURBS racional mantém o raio.
  - Feito: pontos de controle em pares x, y (como a polilinha). `Nurbs { degree, knots, ctrl, weights | null }`, `nurbsDomain`, `nurbsProblem` (mensagem ou null: grau, contagens, nós decrescentes, peso ≤ 0, domínio vazio; o leitor do T36 usa para virar `Opaque` com aviso). `nurbsEval` por de Boor nos pontos ponderados. O achatamento insere cada nó do domínio (Boehm) até a multiplicidade igualar o grau, recorta as peças de Bézier racionais e divide cada uma ao meio até todos os pontos de controle ficarem a ≤ `tol` da corda (segmento, não reta): com pesos positivos a curva fica no fecho convexo deles, então dentro de `tol` da corda. Vale para nós presos e soltos (B-spline uniforme). Os vértices caem na curva; as pontas saem exatas.

- [x] **T36 · ELLIPSE e SPLINE**
  - Arquivos: `entity/{ellipse,spline}.ts` + testes
  - Produz: leitura, desenho (achatado por faixa de zoom), snaps END, gravação DXF. Sem comando de criação.
  - Feito: `Ellipse { cx, cy, mx, my, ratio, t0, t1 }` (parâmetros, anti-horário, iguais = elipse inteira) e `Spline { degree, knots, ctrl, weights | null, closed }`, ambas "curvas livres" (`EntityType.free`): `primitives(e, tol, out, clip?)` dá cordas (tol 0 = 1e-4 do tamanho, para pick, snaps e prévias), `distance` e `nearest` refinam perto do ponto e valem em qualquer zoom (NEA usa `nearest`). A elipse vira peças de Bézier racional quadrática (imagem afim de quartos de círculo, exatas); a spline, peças por inserção de nós (T35), guardadas por entidade. bbox exata na elipse; na spline, a do achatamento crescida da tolerância. Snaps: END (arco de elipse e pontas da spline), CEN e QUA (elipse). Espelhar inverte os parâmetros da elipse. Leitura: centro, eixo e pontos de controle em WCS; elipse com extrusão −Z corre ao contrário; spline fechada (pontos repetidos e nós uniformes) não precisa de tratamento próprio; viram `Opaque` com aviso a extrusão inclinada, a spline 3D, a dada só por pontos de ajuste e a de dados inválidos (`nurbsProblem`). Gravação: edição corrigida no próprio registro (elipse no seu referencial ±Z; spline com nós, pesos e pontos novos, sem os pontos de ajuste e tangentes que não batem mais, `74 = 0`); nova sai fresca; em R12 (que não tem as duas) sai como POLYLINE a 1e-5 do tamanho. Cena: as curvas livres não entram nos pools; uma camada própria as achata a 0,25 px no zoom mais fino da faixa (log2 de px por unidade), só as visíveis e só numa região de três vistas; refaz quando a faixa muda, a vista sai da região, uma curva livre, um layer ou o realce muda, ou num rebuild. O `DraftPack` leva as duas.
  - Verificado com o ezdxf: as splines dele (aberta, fechada, racional, fechada racional) e as elipses (inclusive −Z) caem nas nossas a 1e-11; arquivo com tudo espelhado, movido e duas novas passa por `recover` e `audit` sem erro nem correção, e a geometria que o ezdxf lê bate com a nossa a 2e-7. Visto no app (`--smoke --open --shot`).
  - Limites: TRIM, EXTEND e OFFSET não aceitam elipse nem spline (o AutoCAD aceita); INT e PER com elas usam o achatamento padrão (1e-4 do tamanho); sem MID na elipse.

- [x] **T37 · BLOCK e INSERT**
  - Arquivos: `entity/insert.ts`, `src/kernel/dxf/reader.ts`, `src/render/backend.ts` (`Draw.transform`)
  - Testa: bloco aninhado com escala e rotação cai nas coordenadas esperadas; ida-e-volta DXF.
  - Feito: `Block { name, x, y, entities }` (imutável, entidades sem id em coordenadas do bloco; no layer 0 tomam o layer do insert, `BY_BLOCK` a cor dele) e `Insert { block, x, y, sx, sy, rotation, cols, rows, dx, dy }` (MINSERT incluído). O insert guarda o objeto do bloco, não o nome: os tipos de entidade não veem o documento. Desenha o conteúdo por um sink que aplica a afim de cada cópia (aninhados se compõem sozinhos): semelhança mantém segmentos e arcos exatos (espelhado gira ao contrário); escala desigual vira cordas pelas peças racionais. `PrimSink.look(layer, color)` dá o estilo de cada primitiva (a cena resolve camada a camada). O insert é curva livre (`free(e)`) se o bloco tem elipse ou spline, ou arcos sob escala desigual. bbox, distância (exata por semelhança), MOVE/ROTATE/SCALE/MIRROR compostos (espelho inverte a escala Y, como o AutoCAD), snap novo INS (dois quadrados) e os snaps do conteúdo. Leitura: BLOCKS lido sob demanda, base, nomes sem caixa, `ByBlock` mantido no bloco, OCS −Z, ATTDEF não aparece; bloco que contém a si mesmo, inexistente ou referência externa ficam `Opaque` com aviso. O `DraftPack` leva os blocos (entidades depois dos drafts, índice no insert; cor +1 para separar ByBlock de ByLayer). Gravação: BLOCKS volta como lido; insert editado corrigido no seu OCS, e os ATTRIB que o seguem andam com ele (pontos, altura, giro; espelho mantém a leitura, MIRRTEXT 0); cópia sai fresca, sem atributos.
  - Desvio do plano: sem `Draw.transform`. Desenhar cada insert com sua transformação na GPU custa uma chamada de desenho por insert visível (dezenas de milhares numa planta); expandir na CPU para os pools mantém o desenho em lotes e o culling pelo índice, e aninhamento e cores por primitiva saem de graça. O custo é memória proporcional ao total expandido; instanciar na GPU blocos grandes e muito repetidos fica para depois, se medir fizer falta.
  - Verificado com o ezdxf: as entidades virtuais (explodidas) dele caem nas nossas a 1e-15 (5e-8 nas livres) para aninhado, girado, escala negativa e desigual, −Z e MINSERT, antes e depois de girar, mover, espelhar e copiar; o arquivo gravado passa por `recover` e `audit` sem erro, e o atributo andou com o insert. Visto no app.
  - Limites: atributos não aparecem (texto é o T38) e cópias os perdem ao gravar; layer desligado ou congelado age como desligado (o conteúdo em outros layers aparece); sem BLOCK, BEDIT, EXPLODE nem INSERT; os blocos anônimos das cotas não são desenhados (DIMENSION segue `Opaque`).

- [x] **T38 · TEXT e MTEXT**
  - Arquivos: `entity/text.ts`, `src/render/webgl2/*` (primitiva `glyph`)
  - Produz: atlas de glifos; MTEXT com códigos de formatação removidos.
  - Verifica: texto legível de 6 px a zoom extremo; alinhamento confere com o LibreCAD.
  - Feito: `Text` (ponto da justificação, segundo ponto de alinhado/ajustado, altura de maiúscula, rotação, fator de largura, inclinação, `halign` 0–5, `valign` 0–3, de trás para frente, de cabeça para baixo) e `MText` (valor com códigos, largura, anexo 1–9, rotação, espaçamento). Uma fonte só, a Inter do app: métricas medidas uma vez no Electron e guardadas no kernel (`text/font.ts`: avanços em alturas de maiúscula), então o layout (`text/layout.ts`) roda sem DOM. Códigos `%%c %%d %%p %%nnn \U+XXXX` decodificados; no MTEXT `\P`, `\X`, `\~`, chaves e códigos de formatação (`\f \H \C \S`…) somem, e o texto quebra na largura. Caixa, distância e seleção pela caixa (como o AutoCAD), crossing pela célula de cada letra, snap INS; MIRROR mantém o texto legível (MIRRTEXT 0). Desenho: primitiva `glyph` (origem, eixos U e V, índice), atlas de campos de distância com sinal desenhado por um canvas com a Inter (cobertura antisserrilhada calculada a 4× e reduzida, para curvas lisas ampliadas), glifos desenhados entre quadros (`atlas.work`) com o ASCII aquecido no início, shader com 5 amostras por pixel para o texto pequeno. Comando TEXT/DT/DTEXT (Justify com as 15 opções, TEXTSIZE e rotação lembradas, espaço literal, uma linha por Enter); palavras-chave aceitam as maiúsculas como abreviação. DXF: TEXT (placement por 11 quando justificado), MTEXT (3+1, direção 11/21 acima de 50 em graus) e ATTRIB dos inserts (`Insert.attribs`, tag, oculto, 74 como alinhamento vertical) lidos e gravados — registros novos e edições corrigidas no lugar, grupos ausentes inseridos na ordem do AutoCAD; cópia de insert grava seus ATTRIB e SEQEND; R12 recebe cada linha de um MTEXT como TEXT.
  - Desvio do plano: o alinhamento foi conferido com o ezdxf, não com o LibreCAD (sala limpa). 24 textos e 18 atributos lidos iguais ao ezdxf (ponto por justificação, os dois pontos de alinhamento, altura, ângulos, largura, flags, anexo, espaçamento); os gravados (corrigidos, novos e cópias) passam na auditoria e voltam com os mesmos valores.
  - Verificado no app: legível a 6 px de altura, liso a ~20× numa letra, G3 sem regressão (maior intervalo 133 ms).
  - Limites: uma fonte para todos os estilos (STYLE e `\f` ignorados; larguras diferem das SHX/TTF do arquivo, então caixas não batem com as do AutoCAD); texto visto de −Z fica `Opaque`; MTEXT sem empilhamento visual (`\S` vira texto em linha), sem colunas e sem direção vertical; sem editor de MTEXT nem DDEDIT; atributos multilinha mostram só a linha simples.

## M8 — Carcaça

- [x] **T39 · Barras flutuantes**
  - Arquivos: `src/ui/Toolbar.tsx`, `src/ui/App.tsx`
  - Verifica: todo botão tem `aria-label`, dica com alias e foco visível; navegação por Tab; contraste AA.
  - Feito: três barras no canto superior esquerdo (`src/ui/tools.ts`): Desenhar (LINE, PLINE, CIRCLE, ARC, RECTANG, TEXT), Modificar (MOVE, COPY, ROTATE, MIRROR, SCALE, OFFSET, TRIM, EXTEND, ERASE) e Vista (U, REDO, ZOOM E, PAN). Ícones Lucide; arco e offset desenhados no mesmo traço com `createLucideIcon`. Dica (`role="tooltip"`, ligada por `aria-describedby`) ao passar o mouse e ao focar pelo teclado, com o alias mais curto do `acad.pgp` (Line L, Copy CO, Zoom extents Z E, Undo U, Ctrl+Z). O botão encerra o comando em curso e digita o seu (`AppSession.runCommand`), como o AutoCAD; o comando ativo aparece pressionado (`aria-pressed`, store `active`); depois do clique o botão solta o foco e a digitação segue na linha de comando. Tab segue a ordem de leitura (ferramentas, camada, status, linha de comando); setas andam dentro da barra (padrão toolbar do ARIA); Enter e Espaço acionam só um botão focado pelo teclado (`:focus-visible`), num botão apenas clicado continuam indo para a linha. Em janela baixa as barras quebram numa segunda coluna, longe da linha de comando.
  - Contraste (WCAG, calculado): ícones `--text-muted` (#9AA0A6) sobre `--surface` (#24272B) 5,7:1; texto da dica sobre `--surface-2` 10,8:1 e o alias em `--accent` 9,2:1; ativo `--accent` sobre o fundo realçado (#2C3E44) 7,7:1.
  - Verificado no app: dica ao passar o mouse, LINE pressionado durante o comando, Tab chega nas ferramentas com anel de foco e dica, Enter inicia CIRCLE.

- [x] **T40 · Ajustes**
  - Arquivos: `src/app/settings.ts`, `src/ui/Settings.tsx`
  - Produz: tabela de aliases e modos de osnap em JSON no `userData`; JSON inválido volta ao padrão com aviso.
  - Feito: `settings.json` (`{ version, osnap: ["END", …], aliases: { "L": "LINE", … } }`) em `userData`, lido e gravado inteiro pelo processo principal (`electron/settings.ts`: só do quadro principal da janela, gravação atômica, pasta criada, limite de 1 MB; `--settings=<arquivo>` para testes, e smoke/bench sem ele não tocam o do usuário). `parseSettings` nunca falha: arquivo que não é JSON volta inteiro ao padrão, parte ruim volta ao padrão dela, entrada ruim (modo desconhecido, alias que não é palavra ou que aponta para comando inexistente) sai — cada caso com um aviso na linha de comando. A tabela de aliases do arquivo substitui a padrão inteira, como o acad.pgp; o interpretador troca de aliases em execução (`Interpreter.aliases`) e o snap usa os modos lidos. Painel Ajustes (`role="dialog"`, abas com setas): Object Snap (nove modos, Select All, Clear All) e Aliases (adicionar ou trocar, filtrar, remover, Restore defaults); cada mudança grava na hora. Abre por OSNAP/OS, DSETTINGS/DS/SE, ALIASEDIT, pela engrenagem da barra de status e com clique direito em OSNAP, como no AutoCAD; Esc fecha.
  - Verificado no app: arquivo com modo e alias inválidos dá os dois avisos e usa o resto; marcar Nearest grava o arquivo (pasta criada, sem temporário sobrando).

- [ ] **T41 · Instalador**
  - Arquivos: `electron-builder.yml`, ícone
  - Verifica: instalador NSIS x64 instala, abre, grava e desinstala em máquina limpa.
  - Decidir: `--smoke`, `--shot`, `--bench`, `--play`, `--lose-context` e `--n` funcionam no build empacotado, `--shot` grava PNG em qualquer caminho e `--play` lê qualquer arquivo; padrão recomendado: restringir a `!app.isPackaged`, com exceção explícita para o teste do instalador.
  - Feito: `electron-builder.yml` (electron-builder 26.15.3 em devDependencies): NSIS x64 por usuário, não one-click, pasta escolhível, atalhos na área de trabalho e no menu Iniciar, associação `.dxf` (“DXF Drawing”, abre com o Royale CAD, ícone próprio), `settings.json` mantido ao desinstalar; o asar leva só `out/` e `package.json` (o Vite já empacota React, Lucide e as fontes). `pnpm dist` gera `release/Royale-CAD-Setup-<versão>-x64.exe`; `pnpm dist:dir` o app desempacotado. Ícone: coroa como polilinha fechada com grips do AutoCAD, sobre o fundo do app com a grade (`build/make-icon.py` gera `icon.png` 1024 e `icon.ico` 16–256, com traço mais grosso e sem grade nos tamanhos pequenos). Versão 0.1.0.
  - Decidido: no app empacotado as chaves de teste (`--smoke`, `--shot`, `--play`, `--bench`, `--gate`, `--n`, `--lose-context`, `--settings`) são ignoradas, a não ser com `ROYALE_TEST_SWITCHES=1` (o teste do instalador). `--open` continua, e um `.dxf` passado sozinho (o que o Windows faz pela associação) abre.
  - Verificado aqui: o app Linux empacotado ignora `--smoke --shot` sem a variável (seguiu aberto, nenhum PNG) e com ela abre um DXF, desenha a interface e sai com 0; um `.dxf` sozinho na linha de comando abre. O instalador Windows foi gerado neste Linux (com wine para o desinstalador) e, sob wine, uma variante de teste (só sem a checagem de app aberto, que usa PowerShell, ausente no wine) instalou em silêncio: arquivos, atalhos, entrada de desinstalação e associação `.dxf` no registro; o desinstalador silencioso removeu pasta, atalhos e o ProgId (fica só o valor padrão de `.dxf`, como o electron-builder faz).
  - Falta (precisa de um Windows): abrir e gravar com o app instalado — sob wine o Electron não chega ao fim do smoke — e repetir instalar/desinstalar numa máquina limpa com o instalador real. Instalador sem assinatura de código: o SmartScreen avisa até haver um certificado.
