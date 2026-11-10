import type { MsnUser } from './types'

// Avatares Nostálgicos Frutiger Aero / MSN em SVG Data URI (Vitinho azul, Will verde, Nath rosa)
const AVATAR_VITINHO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0284c7"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
      <linearGradient id="b1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="100%" stop-color="#0369a1"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="18" fill="url(#g1)"/>
    <circle cx="60" cy="44" r="21" fill="url(#b1)" stroke="#e0f2fe" stroke-width="3"/>
    <path d="M24 102 C24 72, 96 72, 96 102 Z" fill="url(#b1)" stroke="#e0f2fe" stroke-width="3"/>
    <text x="60" y="114" font-family="Tahoma" font-size="11" font-weight="bold" fill="#7dd3fc" text-anchor="middle">VITINHO</text>
  </svg>`)

const AVATAR_WILL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs>
      <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#15803d"/>
        <stop offset="100%" stop-color="#052e16"/>
      </linearGradient>
      <linearGradient id="b2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4ade80"/>
        <stop offset="100%" stop-color="#15803d"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="18" fill="url(#g2)"/>
    <circle cx="60" cy="44" r="21" fill="url(#b2)" stroke="#dcfce7" stroke-width="3"/>
    <path d="M24 102 C24 72, 96 72, 96 102 Z" fill="url(#b2)" stroke="#dcfce7" stroke-width="3"/>
    <text x="60" y="114" font-family="Tahoma" font-size="11" font-weight="bold" fill="#86efac" text-anchor="middle">WILL</text>
  </svg>`)

const AVATAR_NATH =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs>
      <linearGradient id="g3" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#db2777"/>
        <stop offset="100%" stop-color="#500724"/>
      </linearGradient>
      <linearGradient id="b3" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f9a8d4"/>
        <stop offset="100%" stop-color="#be185d"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="18" fill="url(#g3)"/>
    <circle cx="60" cy="44" r="21" fill="url(#b3)" stroke="#fce7f3" stroke-width="3"/>
    <path d="M24 102 C24 72, 96 72, 96 102 Z" fill="url(#b3)" stroke="#fce7f3" stroke-width="3"/>
    <text x="60" y="114" font-family="Tahoma" font-size="11" font-weight="bold" fill="#fbcfe8" text-anchor="middle">NATH</text>
  </svg>`)

export const USER_AVATARS: Record<MsnUser, string> = {
  Vitinho: AVATAR_VITINHO,
  Will: AVATAR_WILL,
  Nath: AVATAR_NATH
}

/** Cor de destaque de cada perfil (moldura, nome no chat) */
export const USER_COLORS: Record<MsnUser, { ring: string; text: string; hex: string }> = {
  Vitinho: { ring: 'ring-[#4facfe]', text: 'text-[#1d528d]', hex: '#4facfe' },
  Will: { ring: 'ring-[#52b700]', text: 'text-[#286b00]', hex: '#52b700' },
  Nath: { ring: 'ring-[#ec4899]', text: 'text-[#be185d]', hex: '#ec4899' }
}

/** "Will", "Will e Nath", "Vitinho, Will e Nath" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] || ''
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
}
