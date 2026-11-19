import type { IconSettings } from './types';

/** Base do `site.webmanifest` (PWA). Os caminhos assumem os arquivos na raiz do site. */
export function webManifest(s: IconSettings): string {
  return JSON.stringify({
    name: s.appName,
    short_name: s.shortName,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme_color: s.themeColor,
    background_color: s.backgroundColor,
    display: 'standalone',
    start_url: '/',
  }, null, 2) + '\n';
}

/** Trecho para colar no `<head>`. */
export function headSnippet(s: IconSettings): string {
  return `<!-- Ícones (gerado por Vetorizando) -->
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="${s.themeColor}">
`;
}
