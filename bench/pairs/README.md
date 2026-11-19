# Pares de referência (imagem de produção → SVG de referência)

Use esta pasta para calibrar o motor com **imagens reais** (as embutidas em `bench/cases.ts` são sintéticas).
O objetivo do projeto é o **SVG mais fiel possível** à imagem enviada; por isso os limites protegem SSIM, ΔE (total, de borda e de cor) e HD95.

## 1. Adicionar um par

| Arquivo | Obrigatório | Descrição |
|---|---|---|
| `nome.png` ou `nome.jpg` | sim | a imagem original, **exatamente como o usuário a enviaria** (sem pré-processar) |
| `nome.ref.svg` | não | SVG de referência (de outra ferramenta ou feito à mão). Aparece na linha `↳ ref` com as mesmas métricas, para comparar lado a lado |
| `nome.json` | não | `{ "preset": "logo \| illustration \| photo \| cnc", "options": { "maxColors": 12, ... } }` |

Dicas: use nomes sem espaços; imagens maiores que 1400 px no lado maior são reduzidas (igual à UI); PNG com transparência é aceito (as métricas compõem sobre branco).
**Não commite imagens que você não tenha direito de distribuir.**

## 2. Medir

```bash
npm run bench -- --no-builtin                 # só os pares
npm run bench -- --no-builtin --out out       # + SVG e render PNG de cada um em out/
npm run bench -- --json r.json                # tudo em JSON (para planilhas/diffs)
```

Como ler: **SSIM** alto (≥ 0,98 em logos), **ΔEborda** = erro geométrico (posição/espessura de contornos),
**ΔEplano** = erro de cor (paleta/quantização), **HD95** = deslocamento de bordas em px. Se existir `ref.svg`,
compare `ours` com `↳ ref`: onde `ours` perde, abra `out/nome.render.png` ao lado do original.

## 3. Calibrar os limites de regressão

```bash
npm run bench -- --no-builtin --calibrate           # só mostra os limites propostos
npm run bench -- --no-builtin --calibrate --write   # grava em bench/thresholds.json (chave = nome do par)
```

Os limites propostos têm folga **pequena e fixa** (SSIM −0,002; ΔE ×1,10 + folga; nós ×1,12 + 2) para proteger o ganho atual.
Depois, `npm test` e `npm run bench` falham se uma mudança no motor piorar esse par. Revise o diff de `bench/thresholds.json`
antes de commitar e **nunca afrouxe um limite para fazer o teste passar** — investigue a regressão.
(`npm run bench:calibrate` recalibra também os casos embutidos; use só quando uma melhoria de fidelidade for intencional.)

## 4. Quando o par mostrar um problema

1. `npm run bench -- --no-builtin --out out` e compare `out/nome.render.png` com o original.
2. Se for cor (ΔEplano alto): ajuste `maxColors` / `mergeDeltaE` em `nome.json`.
3. Se for geometria (ΔEborda/HD95 altos): reduza `lineFitTolerance` / `smooth` ou investigue o contorno.
4. Reproduza o defeito num caso mínimo em `bench/cases.ts` + teste em `tests/fidelity.test.ts` antes de corrigir.
