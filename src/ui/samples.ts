export interface Sample {
  id: string;
  label: string;
  draw: (g: CanvasRenderingContext2D, s: number) => void;
}

export const SAMPLES: Sample[] = [
  {
    id: 'logo', label: 'Logotipo',
    draw(g, s) {
      g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
      g.fillStyle = '#2547d0'; g.beginPath(); g.arc(s * .5, s * .42, s * .3, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(s * .33, s * .3); g.lineTo(s * .5, s * .6); g.lineTo(s * .67, s * .3); g.lineTo(s * .58, s * .3); g.lineTo(s * .5, s * .46); g.lineTo(s * .42, s * .3); g.closePath(); g.fill();
      g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(s * .74, s * .2, s * .06, 0, 7); g.fill();
      g.fillStyle = '#171a2b'; g.font = `800 ${s * .12}px system-ui,sans-serif`; g.textAlign = 'center'; g.fillText('VETOR', s * .5, s * .9);
    },
  },
  {
    id: 'icon', label: 'Ícone',
    draw(g, s) {
      g.clearRect(0, 0, s, s);
      g.fillStyle = '#6d5efc'; g.beginPath(); g.roundRect(s * .08, s * .08, s * .84, s * .84, s * .2); g.fill();
      g.fillStyle = '#ffd34d'; g.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? s * .14 : s * .3, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(s * .5 + Math.cos(a) * r, s * .52 + Math.sin(a) * r); }
      g.closePath(); g.fill();
    },
  },
  {
    id: 'art', label: 'Ilustração',
    draw(g, s) {
      const sky = g.createLinearGradient(0, 0, 0, s); sky.addColorStop(0, '#2b2f77'); sky.addColorStop(.55, '#e5566d'); sky.addColorStop(1, '#ffc371');
      g.fillStyle = sky; g.fillRect(0, 0, s, s);
      g.fillStyle = '#fff3c4'; g.beginPath(); g.arc(s * .66, s * .5, s * .13, 0, 7); g.fill();
      g.fillStyle = '#3b2a5a'; g.beginPath(); g.moveTo(0, s * .75); g.bezierCurveTo(s * .2, s * .55, s * .4, s * .8, s * .6, s * .66); g.bezierCurveTo(s * .8, s * .55, s * .9, s * .7, s, s * .64); g.lineTo(s, s); g.lineTo(0, s); g.fill();
      g.fillStyle = '#1b1237'; g.beginPath(); g.moveTo(0, s * .88); g.bezierCurveTo(s * .3, s * .74, s * .6, s * .96, s, s * .82); g.lineTo(s, s); g.lineTo(0, s); g.fill();
    },
  },
  {
    id: 'photo', label: 'Arte complexa',
    draw(g, s) {
      g.fillStyle = '#10243a'; g.fillRect(0, 0, s, s);
      const blobs: [number, number, number, string][] = [[.3, .35, .4, '#ff5d73'], [.7, .3, .35, '#38d6c0'], [.55, .72, .45, '#ffd166'], [.2, .8, .3, '#7b61ff']];
      for (const [x, y, r, c] of blobs) {
        const gr = g.createRadialGradient(s * x, s * y, 0, s * x, s * y, s * r);
        gr.addColorStop(0, c); gr.addColorStop(1, c + '00');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
      }
    },
  },
];

export function renderSample(sm: Sample, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  sm.draw(c.getContext('2d')!, size);
  return c;
}

export function sampleToFile(sm: Sample): Promise<File> {
  const c = renderSample(sm, 720);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(new File([b], `${sm.id}.png`, { type: 'image/png' })) : rej(new Error('canvas'))), 'image/png'));
}
