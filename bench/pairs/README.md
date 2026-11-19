# Pares de referência (imagem original → SVG)

Coloque aqui, para cada caso:

| Arquivo | Obrigatório | Descrição |
|---|---|---|
| `nome.png` ou `nome.jpg` | sim | imagem original (raster) |
| `nome.ref.svg` | não | SVG de referência (ex.: exportado por outra ferramenta). Se existir, as métricas dele aparecem na linha `↳ ref` para comparação direta |
| `nome.json` | não | `{ "preset": "logo\|illustration\|photo\|cnc", "options": { ... } }` para o nosso motor |

Rodar: `npm run bench` (ou `npm run bench -- --no-builtin` só para os pares).
Limites por caso podem ser adicionados em `bench/thresholds.json` (chave = `nome`).
