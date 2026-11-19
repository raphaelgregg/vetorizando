import { flattenCubic } from '../engine/geom';
import type { Options, Pt, VDoc, VPath } from '../engine/types';
import { groupLayers, rgbOf } from './groups';
import { ResolvedSize, fmt } from './size';

/** Tabela ACI (AutoCAD Color Index) reconstruída: 1–9 base, 10–249 matizes, 250–255 cinzas. */
function aciTable(): [number, number, number][] {
  const t: [number, number, number][] = [[0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]];
  const hsv = (h: number, s: number, v: number): [number, number, number] => {
    const f = (n: number) => { const k = (n + h / 60) % 6; return v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))); };
    return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
  };
  const variants: [number, number][] = [[1, 1], [0.5, 1], [1, 0.65], [0.5, 0.65], [1, 0.5], [0.5, 0.5], [1, 0.3], [0.5, 0.3], [1, 0.15], [0.5, 0.15]];
  for (let h = 0; h < 24; h++) for (const [s, v] of variants) t.push(hsv(h * 15, s, v));
  for (const g of [51, 91, 132, 173, 214, 255]) t.push([g, g, g]);
  return t;
}
const ACI = aciTable();

export function nearestAci(rgb: [number, number, number]): number {
  let best = 7, bd = Infinity;
  for (let i = 1; i < ACI.length; i++) {
    const d = (ACI[i][0] - rgb[0]) ** 2 + (ACI[i][1] - rgb[1]) ** 2 + (ACI[i][2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const tolFor = (unit: 'px' | 'mm' | 'cm') => (unit === 'px' ? 0.1 : unit === 'mm' ? 0.02 : 0.002);

interface Vertex { p: Pt; bulge: number }

/** Caminho → vértices de polilinha: retas exatas, arcos como “bulge”, Béziers achatadas. */
function toVertices(p: VPath, tol: number): Vertex[] {
  const v: Vertex[] = [{ p: p.start, bulge: 0 }];
  let cur = p.start;
  for (const s of p.segs) {
    if (s.t === 'L') v.push({ p: s.p, bulge: 0 });
    else if (s.t === 'A') {
      // sweep=1 (sentido horário na tela, Y para baixo) → bulge negativo no DXF (Y para cima)
      const c = Math.hypot(s.p.x - cur.x, s.p.y - cur.y);
      const half = Math.asin(Math.min(1, c / (2 * s.r)));
      const ang = s.large ? 2 * Math.PI - 2 * half : 2 * half;
      v[v.length - 1].bulge = (s.sweep ? -1 : 1) * Math.tan(ang / 4);
      v.push({ p: s.p, bulge: 0 });
    } else {
      for (const q of flattenCubic(cur, s.c1, s.c2, s.p, tol)) v.push({ p: q, bulge: 0 });
    }
    cur = s.p;
  }
  const f = v[0].p, l = v[v.length - 1].p;
  if (v.length > 1 && Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) v.pop();
  return v;
}

/**
 * DXF (R12/AC1009): polilinhas fechadas com arcos nativos (bulge) e retas; Béziers são
 * achatadas (R12 não tem splines). Só geometria (sem preenchimento): uma layer por grupo.
 * Coordenadas na unidade de saída, com Y para cima.
 */
export function toDXF(doc: VDoc, o: Options, size: ResolvedSize): string {
  const tol = tolFor(size.unit) / size.scale; // tolerância em unidades do documento
  const groups = groupLayers(doc, o);
  const layerName = (i: number) => (groups[i].name ? groups[i].name!.toUpperCase().replace(/[^A-Z0-9_$-]+/g, '_') : 'VETORIZANDO');
  const L: (string | number)[] = [999, `Vetorizando - unidade: ${size.unit}`, 0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 0, 'ENDSEC'];
  L.push(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, groups.length);
  groups.forEach((g, i) => L.push(0, 'LAYER', 2, layerName(i), 70, 0, 62, g.layers[0] ? nearestAci(rgbOf(g.layers[0].color)) : 7, 6, 'CONTINUOUS'));
  L.push(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  const X = (x: number) => fmt(x * size.scale, 4), Y = (y: number) => fmt((doc.height - y) * size.scale, 4);
  groups.forEach((g, gi) => {
    for (const layer of g.layers) {
      for (const path of layer.paths) {
        const verts = toVertices(path, tol);
        if (verts.length < 2) continue;
        L.push(0, 'POLYLINE', 8, layerName(gi), 66, 1, 10, 0, 20, 0, 30, 0, 70, 1);
        for (const v of verts) {
          L.push(0, 'VERTEX', 8, layerName(gi), 10, X(v.p.x), 20, Y(v.p.y), 30, 0);
          if (Math.abs(v.bulge) > 1e-9) L.push(42, fmt(v.bulge, 6));
        }
        L.push(0, 'SEQEND', 8, layerName(gi));
      }
    }
  });
  L.push(0, 'ENDSEC', 0, 'EOF');
  return L.join('\n') + '\n';
}
