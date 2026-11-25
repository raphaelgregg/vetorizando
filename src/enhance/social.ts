export interface SocialPreset {
  id: string;
  platform: string;
  label: string;
  width: number;
  height: number;
  /** como a plataforma exibe a imagem: perfil circular, quadrado ou retângulo */
  shape: 'circle' | 'square' | 'rect';
  note: string;
}

/** Tamanhos mais usados (PNG). Perfis são exibidos em círculo: mantenha o assunto no centro. */
export const SOCIAL_PRESETS: SocialPreset[] = [
  { id: 'ig-profile', platform: 'Instagram', label: 'Foto de perfil', width: 320, height: 320, shape: 'circle', note: 'Aparece em círculo; mínimo recomendado 320 × 320.' },
  { id: 'ig-profile-hd', platform: 'Instagram', label: 'Foto de perfil (HD)', width: 1080, height: 1080, shape: 'circle', note: 'Versão em alta resolução do perfil.' },
  { id: 'ig-square', platform: 'Instagram', label: 'Post quadrado (1:1)', width: 1080, height: 1080, shape: 'square', note: 'Formato clássico do feed.' },
  { id: 'ig-portrait', platform: 'Instagram', label: 'Post retrato (4:5)', width: 1080, height: 1350, shape: 'rect', note: 'Ocupa mais área no feed.' },
  { id: 'ig-story', platform: 'Instagram', label: 'Story / Reels (9:16)', width: 1080, height: 1920, shape: 'rect', note: 'Deixe ~250 px livres no topo e na base.' },
  { id: 'wa-profile', platform: 'WhatsApp', label: 'Foto de perfil', width: 640, height: 640, shape: 'circle', note: 'Aparece em círculo; 640 × 640 é o ideal.' },
  { id: 'wa-status', platform: 'WhatsApp', label: 'Status (9:16)', width: 1080, height: 1920, shape: 'rect', note: 'Tela cheia no celular.' },
  { id: 'fb-profile', platform: 'Facebook', label: 'Foto de perfil', width: 400, height: 400, shape: 'circle', note: 'Aparece em círculo (170 px no site).' },
  { id: 'fb-cover', platform: 'Facebook', label: 'Capa', width: 851, height: 315, shape: 'rect', note: 'Proporção ≈ 2,7:1.' },
  { id: 'x-profile', platform: 'X (Twitter)', label: 'Foto de perfil', width: 400, height: 400, shape: 'circle', note: 'Aparece em círculo.' },
  { id: 'x-header', platform: 'X (Twitter)', label: 'Cabeçalho', width: 1500, height: 500, shape: 'rect', note: 'Proporção 3:1.' },
  { id: 'li-profile', platform: 'LinkedIn', label: 'Foto de perfil', width: 400, height: 400, shape: 'circle', note: 'Aparece em círculo.' },
  { id: 'li-banner', platform: 'LinkedIn', label: 'Banner', width: 1584, height: 396, shape: 'rect', note: 'Proporção 4:1.' },
  { id: 'yt-icon', platform: 'YouTube', label: 'Ícone do canal', width: 800, height: 800, shape: 'circle', note: 'Aparece em círculo.' },
  { id: 'yt-banner', platform: 'YouTube', label: 'Banner do canal', width: 2560, height: 1440, shape: 'rect', note: 'Área segura central: 1546 × 423.' },
  { id: 'yt-thumb', platform: 'YouTube', label: 'Miniatura (16:9)', width: 1280, height: 720, shape: 'rect', note: 'Máximo de 2 MB.' },
  { id: 'tt-profile', platform: 'TikTok', label: 'Foto de perfil', width: 200, height: 200, shape: 'circle', note: 'Aparece em círculo.' },
  { id: 'tg-profile', platform: 'Telegram', label: 'Foto de perfil', width: 640, height: 640, shape: 'circle', note: 'Aparece em círculo.' },
  { id: 'dc-avatar', platform: 'Discord', label: 'Avatar', width: 512, height: 512, shape: 'circle', note: 'Aparece em círculo.' },
];

/** Conjunto padrão do "pacote para redes": os perfis mais comuns. */
export const PROFILE_PACK = ['ig-profile', 'wa-profile', 'fb-profile', 'x-profile', 'li-profile', 'yt-icon', 'tt-profile', 'tg-profile'];

export const presetById = (id: string): SocialPreset | undefined => SOCIAL_PRESETS.find((p) => p.id === id);

/** Plataformas na ordem de aparição (para agrupar o seletor) */
export const PLATFORMS = [...new Set(SOCIAL_PRESETS.map((p) => p.platform))];
