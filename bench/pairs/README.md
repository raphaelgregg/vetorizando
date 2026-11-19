# Pares de referência (imagem de produção → SVG de referência)

Use esta pasta para calibrar o motor com **imagens reais** (as embutidas em `bench/cases.ts` são sintéticas e limpas;
imagens de produção são JPEG, têm ruído e bordas suaves — veja o item 6).
O objetivo do projeto é o **SVG mais fiel possível** à imagem enviada; os limites protegem SSIM, ΔE (total, de borda e de cor) e HD95.

## 1. Adicionar um par

| Arquivo | Obrigatório | Descrição |
|---|---|---|
| `nome.png` ou `nome.jpg` | sim | a imagem original, **exatamente como o usuário a enviaria** (sem pré-processar). JPEG: a orientação EXIF é aplicada, como a UI faz |
| `nome.ref.svg` | não | SVG de referência (de outra ferramenta ou feito à mão), **com a mesma proporção da imagem**. Aparece na linha `↳ ref` com as mesmas métricas |
| `nome.json` | não | `{ "preset": "logo \| illustration \| photo \| cnc", "options": { "maxColors": 12, ... } }` (padrão: `logo`) |

- Nomes sem espaços. Imagens com lado maior > 1400 px são reduzidas (igual à UI). PNG com transparência é aceito (métricas compõem sobre branco).
- WebP/AVIF/GIF/SVG-como-imagem **não** são lidos: converta para PNG/JPG antes.
- **Não commite imagens que você não tenha direito de distribuir** (use o `.gitignore` local se for o caso).

## 2. Medir — o comando exato

```bash
npm run bench -- --no-builtin --report --out out
```

- Mostra a tabela (SSIM, ΔE, ΔE95, HD95, nós, ΔEborda, ΔEplano) e, depois, **avisos/erros por par**.
- `--report`: diagnóstico por par — % do erro em **bordas (geometria)** vs **áreas planas (cor)**, os 5 blocos de 64 px com mais erro,
  comparação **nosso × referência** (melhor/pior/igual) e **ranking de margem de ganho**.
- `--out out`: grava, por par, `nome.svg`, `nome.render.png` e **`nome.compare.png`** (original | nosso | mapa de erro em vermelho | referência).
- `--json r.json`: tudo em JSON. `--preset illustration`: força um preset em todos os pares.

Nada derruba a execução inteira: um par com problema vira `ERRO [nome]: …` (imagem ilegível, JSON inválido, preset desconhecido) e os demais continuam; o exit code é 1 (use `--no-fail` para só inspecionar).
Avisos (`aviso [nome]: …`): ref.svg inválido ou com proporção diferente (ignorado), opção desconhecida no `.json`, arquivo sem par, EXIF aplicado, formato não suportado.

## 3. Calibrar os limites de regressão

```bash
npm run bench -- --no-builtin --calibrate           # só mostra os limites propostos
npm run bench -- --no-builtin --calibrate --write   # grava em bench/thresholds.json
```

- A chave dos pares em `thresholds.json` é **`pair:nome`** (os casos embutidos usam só `nome`) — um par chamado `logo` **não** herda os limites do caso sintético `logo`.
- Enquanto um par não tiver limites, a linha mostra `ok (sem limites: rode --calibrate --write)`.
- Folga **pequena e fixa** (SSIM −0,002; ΔE ×1,10 + folga; nós ×1,12 + 2). `--write` **nunca afrouxa** um limite existente (mantém o mais estrito); para afrouxar de propósito, e só com justificativa, use `--loosen`.
- Revise o diff de `bench/thresholds.json` antes de commitar. Depois, `npm test` e `npm run bench` falham se uma mudança no motor piorar o par. **Nunca afrouxe um limite para fazer passar** — investigue a regressão.

## 4. Interpretar o resultado

- **Compare com a referência com cuidado**: ela é medida **contra o raster que você enviou**. Se a imagem é JPEG/suave e o `ref.svg` é um desenho limpo, a referência pode até pontuar *pior* que nós (copiamos o borrão; ela não). O que vale é a coluna certa:
  **ΔEborda** alto = geometria; **ΔEplano** alto = cor/paleta; **nós** ≫ referência = contorno ruidoso.
- `nome.compare.png`: o 3º painel mostra onde está o erro. Bordas onduladas no 2º painel (e lisas na referência) = ruído/JPEG sendo copiado.

## 5. Quando o par mostrar um problema

1. Abra `out/nome.compare.png` e rode `--report` (o ranking aponta onde a margem de ganho é maior).
2. Cor (ΔEplano alto): `maxColors` / `mergeDeltaE` em `nome.json`. Geometria (ΔEborda/HD95): `lineFitTolerance` / `smooth`.
3. Reproduza o defeito num caso mínimo em `bench/cases.ts` + teste em `tests/fidelity.test.ts` antes de corrigir.

## 6. Estresse sintético (sem precisar de pares)

```bash
npm run bench:stress                    # logo, ícone, lineart, texto, ilustração × JPEG 95/85/70/50, ruído σ4/σ10, suavização
npm run bench:stress -- --cases logo    # só um caso
npm run bench:stress -- --ab            # A/B: pré-filtro de ruído desligado × ligado, métricas contra a verdade limpa
npm run bench:stress -- --degs jpeg50,ruido10 --cases icon
```

Degrada os casos embutidos como imagens de produção e mede **contra a entrada** (o que o usuário enviou) **e contra a verdade limpa**,
além de `nós / nós da versão limpa`. Use para ver o quanto ruído/JPEG vaza para o vetor antes de ter pares reais.
