# Vetorizando

Aplicação web de vetorização raster → vetor (PNG/JPG/WebP → SVG/PDF/EPS/DXF) com foco em **precisão geométrica, poucos nós e alta taxa de sucesso**, com UX própria de 3 passos.

> Status: **pré-projeto funcional (v0.1)** na branch `claude-dev`. Motor em TypeScript (atrás de uma interface estável, para trocar por Rust/WASM depois) + UI de 3 passos. Decisões assumidas: processamento 100% no navegador, licença MIT, UI em pt-BR, deploy estático.

## Como rodar

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # testes do motor (vitest)
npm run build      # typecheck + build estático em dist/
```

## O que já existe no v0.1

- **Motor** (`src/engine`): quantização k-means++ em CIE Lab com mescla de tons, remoção de manchas, contornos pelas bordas dos pixels (com furos), contornos **subpixel** a partir da cobertura de anti-aliasing, detecção de cantos multi-escala com **refino por interseção de retas**, ajuste guloso de **retas, arcos circulares, arcos elípticos e Béziers cúbicas** com continuidade G1 e `lineFitTolerance`, modos **cut-outs/stacked**, **gap filler** por traço, remoção de fundo, exportação **SVG** (agrupamento por cor, estilo preenchido/contorno), 4 presets. Roda em Web Worker (nova execução cancela a anterior).
- **UI** (`src/ui`, `src/main.ts`): upload por arrastar/clicar/`Ctrl+V` com validação, 4 exemplos em 1 clique, estúdio com **Antes/Depois deslizante**, zoom/pan (roda, arrastar, pinça, duplo clique), **Raio‑X** (nós e alças), presets, ajustes avançados recolhíveis com reprocessamento ao vivo, tema claro/escuro, download SVG.
- **Testes**: 9 testes do motor (círculo, quadrado, anel com furo, fundo, transparência, empilhado, casos degenerados, SVG válido, determinismo) + verificação ponta a ponta no Chromium (fluxo completo, download, erro de formato, sem erros no console). CI em `.github/workflows/ci.yml`.

## Princípio: fidelidade primeiro

O objetivo é o **SVG mais fiel possível** à imagem enviada; a contagem de nós é secundária e só cai quando não há perda visual.
Prioridades do motor, em ordem: (1) posição/espessura exatas dos contornos, (2) cor exata, (3) preservar traços finos, cantos e detalhes pequenos, (4) menos nós.

## Motor: como reduzimos nós sem perder precisão

1. **Clusters de mistura**: o k‑means cria cores intermediárias de anti-aliasing; elas são detectadas (pequenas e explicáveis como mistura de duas outras) e removidas, e cada pixel de borda recebe a **cobertura** de cada cor (sRGB) → contorno subpixel (marching squares sobre o campo de cobertura).
2. **Cantos**: ângulo em duas escalas (k e 2k) sobre pontos levemente suavizados (num canto o ângulo persiste; numa curva ele dobra) e **refino do vértice** pela interseção das retas ajustadas (TLS) → vértices a < 0,7 px do verdadeiro e fronteiras compartilhadas sem fenda entre regiões.
3. **Primitivas**: a cada passo estende-se o trecho o máximo possível com reta, **arco circular**, **arco elíptico** (Halir–Flusser + extremos exatos, validado por distância geométrica) ou Bézier cúbica; micro-segmentos (< 0,75 px) são absorvidos.
4. **Suavização adaptativa**: a janela da média móvel é limitada pelo tamanho do contorno (formas pequenas/texto não são encolhidas). **Traços finos** (raio hidráulico área/perímetro < 2,2 px, i.e. largura ≲ 4 px) não são suavizados, usam tolerância ≤ 0,25 px e janela de canto menor — sem isso linhas de 2 px colapsavam em caminhos de área zero.
5. **Remoção de manchas sensível a contraste**: componentes com conectividade 8 (uma linha diagonal de 1 px é um só); componente pequeno mas contrastante (linha fina, ponto) é detalhe e fica; só franjas de anti-aliasing (cor entre duas vizinhas grandes) e ruído de baixo contraste saem.
6. **Fusão pós-ajuste conservadora**: 2–3 primitivas vizinhas viram uma só apenas se uma única primitiva cobrir o trecho com desvio ≤ 80% da tolerância contra o contorno original e a junta interna for suave (< 25°); nunca atravessa cantos.
7. **Hairlines (linhas finas) sem tracejado**: a tinta de uma linha de ~1 px se espalha em vários tons de cinza; (a) pixels de traço fino são explicados como mistura dos **extremos da rampa** (ex.: branco↔preto) e não de um cinza intermediário (que gerava fragmentos de 2 px apagados como “mancha”); (b) cristas de 1 px **isoladas** (a tinta continua nos dois lados ao longo da linha; pontas de forma e pontos não contam) usam o nível de isolinha que conserva a espessura, e perfis de 2 px a ~50% não caem abaixo do limiar; (c) contornos **ultrafinos** (largura < ~1,8 px) viram a polilinha exata simplificada em 0,25 px, sem curvas inventadas.
8. **Espessura por estrutura**: o raio hidráulico (tinta/perímetro) é medido por estrutura (contorno externo + furos), de modo que uma grade/moldura de 1 px é tratada como traço fino; cantos finos usam interseção de retas (inclusive quando só o trecho terminal é reta).
9. **Pré-filtro de ruído e artefatos JPEG (adaptativo)** (`src/engine/denoise.ts`): antes da quantização o motor mede (a) o ruído em áreas planas (kernel de Immerkær, só em pixels sem borda) e (b) o *ringing* do JPEG na zona a ≤ 6 px de bordas fortes, onde uma imagem limpa é exatamente plana (percentil 90 do resíduo = 0 em imagens limpas, ≥ 9 até em JPEG q95). **Sem evidência o filtro não age** — a imagem passa pelo mesmo objeto, intacta (o benchmark padrão dá resultados idênticos bit a bit). Com evidência, aplica um **filtro bilateral** (média ponderada por proximidade *e* semelhança de cor; σ de cor proporcional ao ruído estimado; vizinhanças exatamente planas são puladas), com parâmetros por tipo: ruído branco suave (σr ≈ 3σ̂, 1–3 passadas), JPEG mais forte (σr ≈ 10σ̂, 2 passadas). Bordas, cantos vivos, linhas finas e o canal alfa não são misturados/alterados. Com ruído detectado, a cor final de cada camada é a **mediana** por canal dos pixels originais (a média é enviesada pelo corte em 0/255). Controle avançado: “Redução de ruído / JPEG” (0 = desligada, 1 = automática, >1 = mais forte); o indicador “ruído σ̂ · filtrado” aparece nas estatísticas. Imagens apenas *suavizadas* (blur) não são tratadas como ruído.
10. **Gradientes lineares e radiais** (`src/engine/gradient.ts`, opção “Detectar gradientes”): um degradê vira várias bandas após a quantização. Componentes vizinhas cujo contato é *suave* (diferença média entre pixels adjacentes ≤ 10, < 8 % de saltos grandes, ≥ 6 px de contato) são agrupadas — bordas duras, texto, hairlines e áreas planas nunca formam grupo. Cada grupo (área ≥ 800 px, amostras da imagem já filtrada, sem pixels de anti-aliasing) é ajustado por um perfil 1-D (linear: direção por busca angular + refinamento; radial: centro por grade + busca em padrão; radial só se o resíduo cair < 85 % do linear), com *stops* (offset+cor) simplificados por Ramer–Douglas–Peucker (≤ 12). **Guardas de fidelidade**: ΔE76 médio do modelo ≤ o das bandas sólidas + 0,1 (e ≤ 3,5), amplitude de cor ≥ 5 ΔE, nenhum degrau disfarçado (maior salto ≤ 35 % da amplitude) e, depois do traçado, **nós(região única) ≤ nós(bandas)** — senão ficam as bandas. A camada guarda as bandas equivalentes (`fallback`): **SVG** usa `<linearGradient>/<radialGradient>`; **PDF/EPS/DXF e Android Vector Drawable** usam as bandas sólidas; o seletor “Gradientes no SVG” permite bandas também no SVG. Editar a cor de uma camada com gradiente a torna sólida. O preset CNC e o estilo “Contornos” desligam a detecção. Limites: só gradiente linear/radial circular (sem elíptico/cônico/alfa), regiões de rampa contíguas e de contato suave; JPEG forte em degradês ainda fragmenta as bandas que não entram no grupo.
11. **Formas como objetos + cor original por forma** (`src/engine/shapes.ts`, `shapepaint.ts`, opção “Cores originais por forma”): todo caminho recebe um `sid` — a *forma* é o contorno externo + seus furos. Depois do traçado, cada forma é pintada com a **média dos pixels originais limpos** dentro dela (preenchimento por varredura com enrolamento ≠ 0; só rótulos próprios da camada; ΔE < 1,2 da cor da camada mantém a cor da camada, então imagens chapadas saem idênticas) e, se couber, com um **gradiente linear/radial por forma**, aceito só se reduzir o ΔE76 médio em ≥ max(0,8; 25 %) frente à cor sólida e passar nas guardas de degrau/amplitude. Resultado: o brilho metálico de uma letra deixa de ser “duas cores chapadas”.
12. **Editor de formas** (passo 2 → “Editar formas”): clique seleciona (Shift soma, Alt pega a forma de trás), arrastar seleciona por retângulo (Alt: também as que só tocam), pan com botão do meio/direito ou dois dedos. Ações: **excluir**, **recolorir**, **fundir** (une as selecionadas numa única forma; a maior define a cor), **selecionar semelhantes**, **restaurar**, **desfazer/refazer** (Ctrl+Z / Ctrl+Y, Delete exclui). “Mapa de formas” mostra a segmentação com uma cor sólida distinta por forma (só prévia; o SVG exportado não muda). As edições são aplicadas **sobre o vetor** (como a paleta) e valem para SVG/PDF/EPS/DXF/ícones; ao reprocessar são reaplicadas por âncoras (ponto dentro da forma + área, razão 0,5×–2×; as sem correspondência são descartadas com aviso). Em “Recortes” excluir deixa transparente; em “Empilhado” aparece a camada de baixo.
13. **Modo Automático** (`src/engine/analyze.ts`, padrão ao enviar uma imagem): mede, numa versão reduzida e já filtrada de ruído/JPEG, quantas cores dominantes (≥ 0,5 % dos pixels, 4 bits/canal) a imagem tem e que fração dos pixels é plana, de transição suave ou de borda forte. Regras gerais, sem depender do conteúdo: poucas cores e quase nenhuma transição suave → *Logotipo* (cores = dominantes + 2, 6–10); muita variação suave com ≥ 40 cores → *Foto*; o resto (degradês, sombreado) → *Ilustração* (cores ≈ 1,2 × dominantes, 12–32). A escolha e o motivo aparecem no botão “Automático”; qualquer ajuste manual ou preset a substitui. Calibrado nos casos do bench (não numa imagem específica): os 7 casos de arte chapada → Logotipo, ilustração e degradês → Ilustração, foto → Foto, e o resultado automático não perde para o preset manual em SSIM.
14. **Limpeza de fragmentos de transição suave**: a remoção de manchas passou a considerar o contraste — fragmentos de cor parecida com a vizinha (ΔE < 10) são ruído de quantização até 3× a área mínima — e um passo de regularização reatribui pixels isolados (≤ 2 de 8 vizinhos do próprio rótulo) cercados por rótulo de cor parecida (ΔE ≤ 20). Elimina “contas”/fileiras de pontos em brilhos de relevo e degradês sem tocar em linhas finas de alto contraste (numa logo real de 2000 px com 48 cores: 22,8 mil → 13,4 mil nós, mesmo SSIM). Limite conhecido: brilho de relevo muito próximo da cor do fundo ainda pode deslocar a silhueta em 1–2 px em trechos.
15. **Ajuste manual dos pontos e dos gradientes** (o automático é o padrão; o manual corrige o que sobrar): com uma forma selecionada, **Editar pontos** mostra os nós (círculos) e as alças de Bézier (laranja) do contorno — arraste para mover, duplo clique na linha adiciona um ponto sem alterar a forma (de Casteljau), Delete exclui o ponto, “Reta ⇄ curva” alterna a aresta que sai do ponto e “Excluir contorno” remove um contorno indevido (ex.: um furo). Arcos viram Béziers ao editar. O painel “Preenchimento da forma” permite escolher **sólido / linear / radial**, mudar cor e posição de cada parada, adicionar/remover paradas e inverter; as alças brancas na prévia movem a direção (linear) ou o centro e o raio (radial). Vale também para gradientes detectados automaticamente e para criar um em forma sólida. Tudo entra no histórico (Ctrl+Z / Ctrl+Y) e vale para os exportadores (PDF/EPS/DXF usam a cor média do gradiente). Geometria editada à mão não é remapeada ao reprocessar (é descartada com aviso); cor, gradiente, exclusão e fusão são reaplicadas pelas âncoras.
10. **Preenchimento de fendas correto**: os traços ficam numa camada **abaixo** de todos os preenchimentos (antes ficavam sobre cada forma e engrossavam traços ~0,3 px por lado) e, com transparência/fundo removido, são recortados pela união das regiões (`clipPath` no SVG, `W n` no PDF, `clip` no EPS) para não crescer a silhueta.
11. Exportação: elipses viram Béziers em PDF/EPS e polilinhas em DXF R12 (sem elipse nativa); SVG usa `A rx ry rot`.

## Edição de cores no vetor gerado

Painel **Cores** na etapa 2 (Inspecionar), sem reprocessar a imagem — o preview (inclusive Antes/Depois e Raio‑X), o SVG, o PDF, o EPS, o DXF e os ícones refletem a edição na hora.

| Ação | Como |
|---|---|
| Editar uma cor | seletor de cor ou campo HEX (`#abc` / `#aabbcc`; inválido fica em vermelho e não é aplicado) |
| Transparente | botão `∅` da linha (a camada some; o preenchimento de fendas passa a ser recortado pela união das regiões, então a silhueta não engrossa) |
| Remover fundo | um clique: torna transparente a camada de maior área |
| Mesclar selecionadas | marque 2+ cores; camadas que ficam com a mesma cor viram uma só (em “Recortes” os caminhos são somados) |
| Mesclar semelhantes | slider ΔE (CIE76) + botão; cada grupo adota a cor da camada de maior área |
| Restaurar | por cor (“restaurar”) ou a paleta inteira |

- As edições são indexadas pela **cor original** da camada, então valem também depois de reprocessar com outros ajustes.
- Em “Empilhado”, ocultar uma camada que não é a de baixo revelaria a camada abaixo; nesse caso o app troca para “Recortes” e reprocessa (com aviso), mantendo as edições.
- **Cores no SVG exportado**: *hex* (padrão), ***currentColor*** (a cor escolhida herda do CSS da página — ideal para ícones monocromáticos; no Android vira `android:tint="?attr/colorControlNormal"`) ou **classes CSS editáveis** (`<style>.c0{fill:#…}`; as cores ficam num único lugar).
- Implementação: `src/engine/palette.ts` (funções puras que devolvem um novo documento), `src/ui/palette.ts` (painel).

## Ícones para Web, Android e iOS

Etapa 3 → aba **Ícones (Web · Android · iOS)**: escolha plataformas, nome do app, cor do tema, cor de fundo e margem interna; marque os arquivos que quiser e baixe um **.zip organizado por plataforma** (ou cada arquivo, ou só o selecionado). Os ícones usam o vetor **com as cores editadas**.

| Plataforma | Conteúdo |
|---|---|
| **Web** (`web/`) | `favicon.ico` (16, 32, 48 px), `icon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180, opaco), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `site.webmanifest`, `head-snippet.html` |
| **Android** (`android/`) | `res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` (48–192 px) e `ic_launcher_round.png`; Adaptive Icon em `mipmap-anydpi-v26/` (+ `v33` com camada monocromática), `values/ic_launcher_background.xml`; **Vector Drawables** `drawable/ic_launcher_foreground.xml` (108 dp, desenho na zona segura de 66 dp), `ic_launcher_monochrome.xml` e `ic_app_icon.xml` (24 dp, uso geral); `ic_launcher-playstore.png` (512) |
| **iOS** (`ios/AppIcon.appiconset/`) | todos os tamanhos do Xcode para iPhone, iPad e App Store (20, 29, 40, 60, 76, 83,5 pt em 1×/2×/3× e **1024×1024**), **sem canal alfa** (RGB), e `Contents.json` válido |

- Geração 100% no navegador: SVG → canvas (`src/icons/raster.ts`), PNG/ICO/ZIP escritos à mão ou via `fflate` (`src/icons/*`). O Vector Drawable usa o mesmo preenchimento de fendas do SVG.
- Cada plataforma traz um `LEIAME.txt` com onde copiar os arquivos.

## Exportação (SVG · PDF · EPS · DXF), unidades e DPI

Todos os formatos derivam do mesmo modelo vetorial (`src/export`), respeitando **estilo de desenho** (preenchido/contorno), **empilhamento** (recortes/empilhado), **gap filler** e **agrupamento**.

| Formato | Como é gerado | Agrupamento (cor / camada) |
|---|---|---|
| **SVG** | `path` com `M L C A`; `viewBox` + `width/height` na unidade escolhida | `<g>` por cor; por camada usa `inkscape:groupmode="layer"` |
| **PDF** | PDF 1.4/1.5 escrito à mão, Béziers (arcos convertidos), `f` (preenchimento) / `S` (contorno e traços de fenda abaixo dos preenchimentos) | camadas opcionais (**OCG**, PDF 1.5) |
| **EPS** | PostScript nível 3, EPSF‑3.0 com `BoundingBox` | comentários `%%Group:` (PostScript não tem camadas) |
| **DXF** | R12: `POLYLINE` fechada, **arcos nativos (bulge)**, retas exatas, Béziers achatadas (tolerância 0,02 mm); só contornos | uma **layer** por grupo, com cor ACI |

**Tamanho:** `px`, `mm`, `cm` ou `%` (do original) + **DPI** (converte px ↔ medidas físicas; padrão 96). Informe largura **ou** altura — a proporção é sempre preservada. 1 pt = 1/72 pol; DXF usa a unidade escolhida com Y para cima.

**Validação:** testes estruturais (xref do PDF, BoundingBox/geometria do EPS por mini‑interpretador, pares/entidades do DXF), PDF renderizado por `pdftoppm` (SSIM vs SVG ≥ 0,994) e DXF aberto/auditado com `ezdxf` (0 erros) nas verificações manuais.

## Benchmark de qualidade (`npm run bench`)

Compara o **raster original** com o **SVG renderizado** (renderizador `resvg`, independente do nosso motor) usando:

| Métrica | Significado |
|---|---|
| **SSIM** | similaridade estrutural na luminância (janela 7×7; 1 = idêntico) |
| **ΔE / ΔE95** | diferença de cor CIE76 média e percentil 95 |
| **HD95 / HDmax** | distância de Hausdorff (percentil 95 / máxima, em px) entre mapas de bordas fortes (ΔE ≥ 25) |
| **ΔEborda / ΔEplano** | ΔE médio só nos pixels de borda (≤ 2 px de um contraste) = erro **geométrico**; e só nas áreas planas = erro de **cor** (paleta/quantização) |
| **nós, KB, ms** | complexidade, tamanho do SVG e tempo (secundários: fidelidade vem primeiro) |

```bash
npm run bench                          # casos embutidos + pares em bench/pairs
npm run bench -- --no-builtin          # só os pares de referência
npm run bench -- --out out --json r.json --preset illustration
```

- **Casos embutidos** (`bench/cases.ts`): logo, ícone, ilustração, foto/degradê, lineart, listras — gerados de fontes vetoriais com anti-aliasing, então reproduzíveis sem arquivos binários.
- **Pares de referência** (`bench/pairs/`): coloque `nome.png|jpg` + opcional `nome.ref.svg` e `nome.json`, e rode `npm run bench -- --no-builtin --report --out out` (diagnóstico por par, imagem comparativa e ranking de margem de ganho); `--calibrate --write` grava os limites `pair:nome`. Erros de um par não derrubam os outros. Guia completo em `bench/pairs/README.md`.
- **Estresse** (`npm run bench:stress`): degrada os casos embutidos (JPEG, ruído, suavização) e mede contra a entrada e contra a verdade limpa. `-- --ab` compara **sem filtro × com filtro** lado a lado (nós, SSIM, ΔE, ΔEborda, ΔEplano); `--cases`, `--degs` e `--denoise N` filtram/ajustam.
- **Regressão**: `bench/thresholds.json` define limites por caso (SSIM, ΔE, ΔEborda, ΔEplano, HD95, nós); `npm test` falha se algum caso piorar; a taxa de sucesso é impressa no final. `npm run bench:calibrate` recalibra a partir dos resultados atuais (use só em melhorias intencionais; **nunca afrouxe um limite para fazer passar**).
- **Calibrar com imagens reais**: ver o passo a passo em `bench/pairs/README.md` (`npm run bench -- --no-builtin --calibrate --write`).
- Hausdorff só é significativo com bordas duras: em degradês a quantização cria “bandas” que o original não tem (por isso HD95 não é exigido em ilustração/foto).

Resultados atuais (SSIM / ΔE / ΔEborda / nós): logo 0,9987 / 0,07 / 0,98 / 69 · ícone 0,9964 / 0,18 / 2,58 / 51 · lineart 0,9969 / 0,18 / 1,60 / 74 · texto 0,9960 / 0,20 / 1,98 / 753 · elipses 0,9980 / 0,36 / 2,21 / 56 · listras 0,9981 / 0,07 / 1,15 / 32 · detalhes finos 0,9965 / 0,13 / 1,13 / 766 · ilustração 0,9794 / 0,84 / 4,72 / 557 · foto 0,8714 / 5,28 / 10,12 / 3492.

## Lacunas conhecidas (próximas iterações)

1. **Texto** ainda usa ~9–10 nós por glifo (aprox. no piso para tolerância 0,5 px); retângulos arredondados saem como Béziers em vez de `L`+`A` (menos nós, mas menos “semânticos”); fusão pós-ajuste entre primitivas vizinhas ainda não existe.
2. **Degradês/foto** viram bandas (limite da quantização por cores; mais cores melhoram ΔE mas pioram SSIM por fragmentação): foto SSIM ≈ 0,87. Hairlines **< ~0,5 px** de tinta (cobertura < 0,3 por pixel) ainda podem se perder: abaixo disso o sinal é indistinguível de ruído.
3. **Gap filler** hoje é traço por caminho (`paint-order`); falta validação automática de ausência de fendas.
4. **DXF** só em R12 (Béziers viram polilinhas; sem splines/hachuras); **EPS** sem camadas reais (grupos em comentários) e **sem validação em Ghostscript** (verificado por interpretador próprio de teste); PDF sem compressão.
5. **Pares de referência reais** (imagem → SVG de outra ferramenta) ainda não foram adicionados a `bench/pairs/`.
6. Imagens são reduzidas a 1400 px no lado maior no processamento; **Rust/WASM** para desempenho e precisão em imagens grandes.
7. Editar paleta (trocar/mesclar cores) no estúdio; colar URL de imagem; i18n/en; testes E2E automatizados no CI.


---

## 1. Diagnóstico do repositório atual

| Item | Situação |
|---|---|
| Remoto | `https://github.com/raphaelgregg/vetorizando` — vazio (sem commits, sem branches) |
| Estrutura de pastas | Inexistente (greenfield) |
| Stack / dependências | Nenhuma |
| CI, testes, licença | Inexistentes |

**Pontos em aberto (decisões necessárias):**
1. Hospedagem/privacidade: processar 100% no navegador (privado, sem custo de servidor) ou também via servidor?
2. Licença do projeto (MIT/Apache-2.0 vs. copyleft — afeta o uso de libs como Potrace/GPL).
3. Limite de tamanho de imagem alvo (ex.: 4096 px no lado maior).
4. Idioma da UI: pt-BR inicial + i18n?
5. Deploy alvo (Vercel/Cloudflare Pages estáticos são suficientes se for client-side).

---

## 2. Arquitetura do motor de vetorização

### 2.1 Estratégia recomendada: pipeline híbrido, **client-side first**

- **Motor em Rust compilado para WebAssembly**, executado em **Web Worker** (UI nunca trava; `OffscreenCanvas`/`ImageData` transferíveis).
- **Frontend:** TypeScript + Vite + React (ou Svelte) + Canvas/WebGL para o viewer.
- **Fallback opcional (fase tardia):** o mesmo crate Rust como binário/serviço (Axum) para imagens muito grandes ou exportações pesadas (PDF/EPS).

| Opção | Prós | Contras |
|---|---|---|
| **Rust→WASM no navegador (escolhida)** | Privacidade total, zero custo de infra, rápido, determinístico | Limite de memória do browser; ecossistema de PDF/EPS menor |
| Serviço Python/Node (OpenCV, Potrace) | Libs maduras | Custo, latência, upload de imagens do usuário |
| C++ (Potrace/AutoTrace) via WASM | Maduro | GPL (Potrace), só monocromático, menos controle |
| Híbrido (WASM + serviço) | Escala p/ casos extremos | Complexidade dupla — adiado |

### 2.2 Pipeline do motor

```
Entrada → Pré-processamento → Quantização de cor → Segmentação em regiões
        → Extração de contornos subpixel → Ajuste de curvas → Topologia/empilhamento
        → Gap filler → Otimização → Exportadores
```

1. **Pré-processamento:** decodificação, normalização sRGB, tratamento de alfa, denoise leve (bilateral/median opcional), upscale 2× (Lanczos) para imagens pequenas, detecção de fundo.
2. **Quantização de cor:** k-means++ / median-cut em espaço **CIE Lab**, com mesclagem de tons próximos (ΔE2000 < limiar) e limite `max_colors`; suavização de bordas anti-aliasing antes de rotular (evita "regiões fantasma" de transição).
3. **Segmentação:** rotulagem por componentes conectados + remoção de ruído (`speckle_size`, remoção de ilhas/buracos mínimos).
4. **Contornos subpixel:** traçado de bordas em grade com interpolação a partir do gradiente (marching-squares sobre campo de distância/cobertura), garantindo contornos compartilhados entre regiões vizinhas (sem lacunas por construção quando possível).
5. **Ajuste de curvas (precisão):**
   - Detecção de **cantos** por ângulo/curvatura; segmentação do contorno nos cantos.
   - Ajuste por segmento: **linha reta → arco circular → Bézier quadrática → Bézier cúbica** (menor primitiva que satisfaz a tolerância).
   - Algoritmo: mínimos quadrados com reparametrização iterativa (Schneider) + simplificação Ramer-Douglas-Peucker prévia; fusão de segmentos G1/C1 colineares.
   - Parâmetros: `line_fit_tolerance` (px, subpixel, ex. 0.1–2.0), `corner_threshold` (°), `arc_fitting` (on/off), `max_nodes_per_path` (guarda).
   - **Objetivo medível:** erro Hausdorff máx. ≤ `line_fit_tolerance` e minimizar nº de nós (sem serrilhado).
6. **Empilhamento de formas (Shape Stacking):**
   - **Cut-outs:** regiões disjuntas (sem sobreposição), com furos via `fill-rule: evenodd`; ideal para vinil/corte.
   - **Stacked:** camadas ordenadas (fundo → frente) com cada forma ligeiramente expandida sobre a anterior; elimina frestas e reduz nº de buracos/caminhos.
7. **Gap Filler:** em modo cut-out, dilata cada região por δ (padrão ≈ 0,5 px, configurável) apenas nas fronteiras compartilhadas, ou adiciona traço (`stroke`) de mesma cor com largura mínima; modo “none” disponível. Valida-se por teste de render sem fendas.
8. **Paleta e fundo:** paleta extraída editável (trocar/mesclar cores), cor de fundo detectada por amostragem de bordas, opção de remover (transparente) ou manter; tolerância configurável.
9. **Otimização final:** arredondamento a N casas decimais, remoção de nós redundantes, ordenação de caminhos (menos troca de ferramenta para CNC/plotter), deduplicação.

### 2.3 Exportação e agrupamento

| Formato | Abordagem |
|---|---|
| **SVG** | Gerado nativamente (paths `M/L/C/Q/A`, `viewBox`, unidades) |
| **PDF** | Vetorial nativo (ex.: `pdf-lib`/`printpdf` no Rust) a partir do mesmo modelo interno |
| **EPS** | Escritor PostScript próprio (Level 2) a partir do modelo interno |
| **DXF** | Escritor DXF (R12/R2000: `LWPOLYLINE`, `SPLINE`/`ARC`; Béziers → splines ou polilinhas com tolerância), camadas por cor |

- **Agrupamento:** por **Cor** (`<g>` por cor), por **Camada** (ordem de empilhamento / camadas DXF) ou **Sem agrupamento**.
- **Unidades:** `px`, `mm`, `cm`, `%` com DPI configurável e escala (largura/altura finais).
- **Modelo interno único** (`VectorDocument`: camadas → formas → caminhos → segmentos), do qual todos os exportadores derivam — garante consistência entre formatos.

### 2.4 Como medir “qualidade ≥ referência”

Conjunto de benchmark versionado (logos, ícones, ilustrações, lineart, foto, texto, gradientes, baixa resolução). Métricas automáticas:
- **SSIM / ΔE médio** entre raster original e SVG re-renderizado.
- **Erro de borda (Hausdorff / Chamfer)**.
- **Nº de nós e caminhos** por imagem (menos é melhor, a qualidade igual).
- **Taxa de sucesso:** % de imagens que processam sem erro, dentro do tempo e limiar de qualidade.
- **Tempo/memória** por megapixel.
- Comparação cega visual contra resultados de referência (apenas para calibração interna).

---

## 3. Design de UI/UX original — fluxo de 3 passos

Identidade própria: tipografia geométrica, paleta calma com cor de destaque, cantos arredondados, foco em um único painel por vez. Temas **claro/escuro** (segue `prefers-color-scheme`, alternável).

### Passo 1 — Upload instantâneo
- **Drag & drop** em tela cheia, seletor de arquivo e **colar com `Ctrl+V`/`Cmd+V`** (clipboard de imagem).
- **Exemplos prontos** (galeria de 6–8) com 1 clique: logo, ícone, ilustração, foto, lineart, texto.
- Validação imediata (tipo, tamanho, dimensões) com mensagens claras; progresso de processamento no próprio Worker (cancelável).

### Passo 2 — Estúdio de inspeção
- **Split-view deslizante** Antes/Depois com alça arrastável (e atalho de teclado).
- **Zoom e Pan fluidos** (roda, pinça, arrastar, `Space`+arrastar; atalhos `+/-/0`); render com viewport virtual para suportar SVGs pesados.
- **Modo Raio-X / Wireframe:** contornos, **nós** e **alças de Bézier** sobre a imagem original, com cores por tipo de segmento (reta/arco/curva) e contador de nós/caminhos/cores.
- Painel lateral enxuto: paleta (editar/mesclar/remover cor), fundo (manter/remover), estatísticas.

### Passo 3 — Exportação simples + avançada
- **Presets rápidos:** *Logotipo/Ícone*, *Ilustração*, *Foto/Arte Complexa*, *Corte CNC/Laser* (cada um define colorsMax, tolerância, empilhamento, gap filler, suavização).
- **Avançado (recolhível):** `max_colors`, `line_fit_tolerance`, `corner_threshold`, `speckle_size`, empilhamento (cut-out/stacked), gap filler, paleta, fundo, agrupamento, unidades/DPI, precisão decimal.
- Escolha do formato (SVG/PDF/EPS/DXF), tamanho final e botão único **Baixar**; reprocessamento em tempo real ao ajustar parâmetros (debounce + preview em baixa resolução).
- Acessibilidade: navegação por teclado, contraste AA, `aria-*`, `prefers-reduced-motion`; i18n pt-BR/en.

---

## 4. Plano de implementação em fases (branch `claude-dev`)

Cada fase termina com commit(s) pequenos, testes passando e critérios de aceite verificados. Merge em `main` só com aprovação.

| Fase | Entregas | Critérios de aceite | Testes de validação |
|---|---|---|---|
| **0 — Fundações** | Monorepo (`web/`, `engine/` Rust, `bench/`), Vite+TS, lint/format, CI (build + test), LICENSE | `npm run dev` abre app “hello”; CI verde | Smoke de build |
| **1 — Motor v0** | Crate Rust→WASM, Worker, decodificação, quantização Lab, componentes conectados, contornos poligonais → SVG | Imagem de exemplo vira SVG válido no browser em <2 s (≤1 MP) | Testes unitários de quantização/segmentação; validação XML do SVG |
| **2 — Curvas** | Detecção de cantos, ajuste reta/arco/Bézier, `line_fit_tolerance` | Erro de borda ≤ tolerância; nós ≤ baseline poligonal ×0,3 | Property-tests (curva reconstruída vs. contorno), métrica Hausdorff |
| **3 — Empilhamento + Gap filler** | Modos cut-out e stacked, gap filler, hierarquia de furos | Render sem fendas visíveis (teste de diff em zoom 800 %) | Golden images, teste de fendas por pixel |
| **4 — Paleta e fundo** | Mesclagem ΔE, edição de paleta, remoção de fundo | Fundo sólido removido em ≥ 95 % do conjunto de teste | Benchmark com fundos conhecidos |
| **5 — UI passo 1** | Upload, DnD, Ctrl+V, exemplos, erros tratados | Fluxo completo upload → resultado; erros legíveis | E2E Playwright; testes de arquivo inválido/gigante |
| **6 — UI passo 2** | Split-view, zoom/pan, Raio-X/Wireframe | 60 fps em pan/zoom com SVG de 20 k nós; wireframe mostra nós/alças corretos | E2E + teste visual; perfilamento |
| **7 — Exportadores** | SVG final, PDF, EPS, DXF, agrupamento, unidades | Arquivos abrem em Inkscape/Illustrator-compat/LibreOffice/CAD; dimensões em mm corretas | Round-trip (render do export vs. original), validação de formato |
| **8 — UI passo 3 + presets** | Presets, avançado recolhível, temas, a11y, i18n | Preset gera resultado correto por categoria; Lighthouse a11y ≥ 95 | E2E, axe-core |
| **9 — Qualidade e robustez** | Benchmark automatizado (SSIM, ΔE, Hausdorff, nós), limites de memória, cancelamento, fallback | Taxa de sucesso ≥ 98 % no conjunto; sem travar UI | Suíte de benchmark no CI; fuzz de entradas |
| **10 — Release** | Docs, deploy estático, telemetria opcional (opt-in) | Deploy publicado; README com uso | Smoke em produção |

### Tratamento de erros (transversal)
- Arquivo corrompido/formato não suportado/muito grande → mensagem acionável (sem stack trace) e opção de reduzir automaticamente.
- Falta de memória/timeout no Worker → degradação (downscale + aviso) em vez de falha.
- Resultados vazios/degenerados (imagem toda uma cor) → resultado válido mínimo + aviso.
- Cancelamento e reprocessamento sempre seguros (Worker recriável).

---

## 5. Fluxo Git

- `main`: contém este plano (push inicial).
- `claude-dev`: todo desenvolvimento a partir daqui. Sem pushes diretos em `main` nesta fase.

## Licença
A definir (ver pontos em aberto).

---

## 6. Referência: análise do HAR (simulação de vetorização no Vectorizer.AI)

Fonte: captura de rede (`pt.vectorizer.ai`, 27 requisições) de uma sessão de vetorização que terminou em download.

**O que o HAR contém e o que não contém**
- O único passo de vetorização capturado é o `POST .../images/<id>/download`, que respondeu **303 → `/pricing`** (download bloqueado por plano pago). Não há SVG de saída, nem o stream de geometria do preview (protocolo binário `application/x-vk-foreground-stream`, com frames de progresso/revisão/geometria/erro).
- Em compensação, há o **formulário completo de opções de saída** e o JS da interface, que mostram o modelo de parâmetros e o fluxo de UX. Usamos isso só como referência funcional; **código e layout deles não serão copiados**.

**Modelo de parâmetros observado (base do nosso `OutputOptions`)**

| Grupo | Parâmetros / valores observados |
|---|---|
| Formato | `file_format` (svg; pdf/eps/dxf/png existem na UI), `svg.version` (`svg_1_1`), `svg.adobe_compatibility_mode`, `pdf.version` (`PDF_1_4`), `eps.version` (`PS_3_0_EPSF_3_0`), `dxf.compatibility_level` (`lines_and_arcs`) |
| Presets | `ui.preset`: `general` (fill, cutouts, group none, gap filler on), `editing` (fill, **stacked**, group **color**, gap filler off), `cutting` (**stroke_edges**, cutouts, group none, gap filler off) |
| Estilo | `draw_style`: `fill_shapes` \| `stroke_shapes` (contornos) \| `stroke_edges` (arestas, p/ corte) |
| Empilhamento | `shape_stacking`: `cutouts` \| `stacked` |
| Agrupamento | `group_by`: `none` \| `color` \| `layer` \| `parent` (hierarquia) |
| Curvas | `curves.allowed.{quadratic_bezier,cubic_bezier,circular_arc,elliptical_arc}` (cada tipo liga/desliga), `curves.line_fit_tolerance` (padrão **0.1**), `parameterized_shapes.flatten` (formas nativas vs. achatadas em paths) |
| Gap filler | `gap_filler.enabled`, `.clip`, `.non_scaling_stroke`, `.stroke_width` (padrão 2.0) — implementado como **traço** sob as formas, não dilatação |
| Traços | `strokes.stroke_width` (1.0), `.non_scaling_stroke`, `.use_override_color`/`.override_color` (`#000000`) |
| Tamanho | `size.mode` (`automatic`\|`scale`\|`width`\|`height`\|`fit_inside`\|`fill_box`\|`stretch`), `size.unit` (`px`…), `size.output_dpi`, `size.aspect_ratio` (`preserve_inset`\|`preserve_overflow`\|`stretch`), `size.align_x/y` (0.5) |

**Decisões que isso muda no plano**
1. **Estilos de desenho** — adicionar `stroke_shapes` e `stroke_edges` (corte CNC/laser usa arestas, não preenchimento); incluir em `OutputOptions` e no preset *Corte CNC/Laser*.
2. **Gap filler por traço** (`stroke_width`, `non_scaling_stroke`) como implementação padrão no SVG; dilatação geométrica fica para PDF/EPS/DXF, onde traço não escala como no SVG.
3. **Agrupamento** ganha `parent` (hierarquia) além de `color`/`layer`/`none`.
4. **Tipos de curva ligáveis individualmente** (inclusive arco elíptico) e opção de **formas nativas vs. achatadas** — importante para compatibilidade com editores/CAD.
5. **Fluxo de UX validado:** o preview é gerado por *streaming progressivo* (progresso → geometria por revisão) e o formulário de download é separado do preview; nosso estúdio fará o mesmo, com render incremental vindo do Worker.
6. **Entrada:** a UI deles trata arrastar, selecionar, **colar (`Ctrl+V`)** e **URL** como métodos de entrada; adicionaremos "colar URL de imagem" ao Passo 1.
7. **Paywall:** o bloqueio no download é decisão de negócio deles; no Vetorizando o download é local e gratuito (a definir).
8. **Resumo do estado** em chips (ex.: "Draw: Filled", "Stack: Cut-outs", "Group by: None", "Size: Unchanged") — bom padrão de UX para o painel avançado recolhido; adotaremos algo equivalente.

**Limite da referência:** sem o SVG resultante, não dá para comparar qualidade geométrica a partir deste arquivo. Para calibrar o benchmark (seção 2.4) preciso de pares *imagem original → SVG baixado* (idealmente exportados por você).
