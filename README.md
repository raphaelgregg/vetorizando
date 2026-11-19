# Vetorizando

Aplicação web de vetorização raster → vetor (PNG/JPG/WebP → SVG/PDF/EPS/DXF) com foco em **precisão geométrica, poucos nós e alta taxa de sucesso**, com UX própria de 3 passos.

> Status: **fase de planejamento**. Nenhum código de funcionalidade foi implementado ainda.

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
