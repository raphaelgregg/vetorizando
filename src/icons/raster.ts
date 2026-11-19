import type { Renderer } from './types';

/** Rasteriza um SVG quadrado no navegador (canvas); a imagem sai exatamente em `size`×`size`, sem pré-multiplicação. */
export const renderSvgInBrowser: Renderer = async (svg, size) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size);
    return { data: d.data, width: size, height: size };
  } finally {
    URL.revokeObjectURL(url);
  }
};
