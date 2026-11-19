import type { Options, VDoc } from '../engine/types';
import type { SvgColors } from '../engine/svg';
import { renderSvgInBrowser } from '../icons/raster';
import { buildIconAssets, zipAssets } from '../icons/package';
import { AssetFile, DEFAULT_ICON_SETTINGS, IconSettings, Platform } from '../icons/types';

export interface IconsHost {
  doc(): VDoc | null;
  options(): Options;
  svgColors(): SvgColors;
  name(): string;
  origWidth(): number;
  /** cor original do fundo da imagem (hex) */
  backgroundColor(): string | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PLATFORM_NAMES: Record<Platform, string> = { web: 'Web', android: 'Android', ios: 'iOS' };

function download(name: string, data: Uint8Array | string, mime: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const MIME: Record<AssetFile['kind'], string> = { png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml', xml: 'application/xml', json: 'application/json', txt: 'text/plain', html: 'text/html' };
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const bytes = (f: AssetFile) => (typeof f.data === 'string' ? new TextEncoder().encode(f.data).length : f.data.length);

/** Modo "Ícones": gera Web/Android/iOS a partir do vetor (com as cores editadas) e baixa em .zip ou arquivo a arquivo. */
export function initIcons(host: IconsHost) {
  let files: AssetFile[] = [];
  const picked = new Set<string>();
  let token = 0, timer = 0, active = false;
  const thumbs: string[] = [];

  const settings = (): IconSettings => ({
    ...DEFAULT_ICON_SETTINGS,
    appName: $<HTMLInputElement>('icname').value.trim() || 'App',
    shortName: $<HTMLInputElement>('icshort').value.trim() || 'App',
    themeColor: $<HTMLInputElement>('ictheme').value,
    backgroundColor: $<HTMLInputElement>('icbg').value,
    padding: Number($<HTMLInputElement>('icpad').value) / 100,
    platforms: { web: $<HTMLInputElement>('icweb').checked, android: $<HTMLInputElement>('icand').checked, ios: $<HTMLInputElement>('icios').checked },
    svgColors: host.svgColors(),
  });

  const status = (t: string) => { $('icstatus').textContent = t; };

  function renderList() {
    thumbs.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const box = $('iconfiles');
    box.replaceChildren();
    for (const platform of ['web', 'android', 'ios'] as Platform[]) {
      const group = files.filter((f) => f.platform === platform);
      if (!group.length) continue;
      const g = document.createElement('div');
      g.className = 'icgroup';
      const head = document.createElement('label');
      head.className = 'ichead';
      const all = Object.assign(document.createElement('input'), { type: 'checkbox', checked: group.every((f) => picked.has(f.path)) });
      all.addEventListener('change', () => { for (const f of group) all.checked ? picked.add(f.path) : picked.delete(f.path); renderList(); updateZip(); });
      head.append(all, `${PLATFORM_NAMES[platform]} — ${group.length} arquivos`);
      g.append(head);
      for (const f of group) {
        const r = document.createElement('div');
        r.className = 'icrow';
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: picked.has(f.path) });
        cb.setAttribute('aria-label', f.path);
        cb.addEventListener('change', () => { cb.checked ? picked.add(f.path) : picked.delete(f.path); updateZip(); });
        const th = document.createElement('div');
        th.className = 'th';
        if (f.kind === 'png' || f.kind === 'svg') {
          const u = URL.createObjectURL(new Blob([f.data as BlobPart], { type: MIME[f.kind] }));
          thumbs.push(u);
          th.append(Object.assign(document.createElement('img'), { src: u, alt: '' }));
        } else th.textContent = f.kind.toUpperCase();
        const info = document.createElement('div');
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = f.path.slice(f.path.indexOf('/') + 1);
        const small = document.createElement('small');
        small.textContent = `${f.note} · ${kb(bytes(f))}`;
        info.append(nm, small);
        const dl = document.createElement('button');
        dl.textContent = '↓';
        dl.title = `Baixar ${f.path.split('/').pop()}`;
        dl.addEventListener('click', () => download(f.path.split('/').pop()!, f.data, MIME[f.kind]));
        r.append(cb, th, info, dl);
        g.append(r);
      }
      box.append(g);
    }
    updateZip();
  }

  function updateZip() {
    const n = files.filter((f) => picked.has(f.path)).length;
    const btn = $<HTMLButtonElement>('iczip');
    btn.disabled = n === 0;
    btn.textContent = n === files.length && n > 0 ? `Baixar pacote .zip (${n} arquivos)` : `Baixar .zip (${n} selecionados)`;
  }

  async function build() {
    const doc = host.doc();
    if (!doc || !active) return;
    const mine = ++token;
    status('Gerando ícones…');
    try {
      const out = await buildIconAssets(doc, host.options(), settings(), renderSvgInBrowser, host.origWidth());
      if (mine !== token) return;
      const had = new Set(files.map((f) => f.path));
      files = out;
      for (const f of files) if (!had.has(f.path)) picked.add(f.path); // arquivos novos entram marcados; as escolhas do usuário permanecem
      for (const p of [...picked]) if (!files.some((f) => f.path === p)) picked.delete(p);
      renderList();
      status(`${files.length} arquivos prontos.`);
    } catch (e) {
      if (mine === token) status('Não foi possível gerar os ícones: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(build, 250); };
  $('icname').addEventListener('input', () => { $('icname').dataset.touched = '1'; });
  for (const id of ['icname', 'icshort', 'ictheme', 'icbg', 'icpad', 'icweb', 'icand', 'icios']) $(id).addEventListener('input', () => {
    if (id === 'icpad') $('icpadv').textContent = `${$<HTMLInputElement>('icpad').value}%`;
    schedule();
  });
  $('icbgorig').addEventListener('click', () => {
    const c = host.backgroundColor();
    if (c) { $<HTMLInputElement>('icbg').value = c; schedule(); }
  });
  $('iczip').addEventListener('click', () => {
    const sel = files.filter((f) => picked.has(f.path));
    if (!sel.length) return;
    download(`${host.name()}-icones.zip`, zipAssets(sel), 'application/zip');
  });

  return {
    /** mostrar/ocultar o modo (só gera quando visível) */
    setActive(on: boolean) { active = on; if (on) { build(); } },
    invalidate() { if (active) schedule(); },
    /** sugere o nome do arquivo como nome do app, enquanto o usuário não tiver digitado o dele */
    setName(n: string) { const i = $<HTMLInputElement>('icname'); if (!i.dataset.touched) i.value = n; },
  };
}
