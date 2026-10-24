import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  Notification,
  session
} from 'electron'
import { join, extname } from 'path'
import { createServer, Server as HttpServer } from 'http'
import { readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import Store from 'electron-store'
import ytSearch from 'yt-search'

// ============================================================================
// 1. FLAGS CRÍTICAS DE HARDWARE, MEMÓRIA E ZERO ECO (ANTES DO app.whenReady)
// ============================================================================
app.commandLine.appendSwitch(
  'enable-features',
  'WebRtcAllowInputVolumeAdjustment,PulseaudioLoopbackForScreenShare'
)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('enable-accelerated-video-encode')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ============================================================================
// 2. TIPOS E PERSISTÊNCIA HÍBRIDA (electron-store + Supabase)
// ============================================================================
export interface AlbumTrackItem {
  trackId: string
  trackNumber: number
  trackName: string
  durationMs: number
  previewUrl?: string
}

export interface AlbumSearchResult {
  albumId: string
  albumName: string
  artistName: string
  artworkUrl: string
  releaseYear: string
  trackCount: number
  provider: 'itunes' | 'deezer'
}

export interface AlbumRankingRecord {
  id?: string
  album_id: string
  album_name: string
  artist_name: string
  artwork_url: string
  release_year?: string
  tracks_metadata: AlbumTrackItem[]
  vitinho_rating?: number | null
  vitinho_comment?: string | null
  vitinho_track_order?: string[] | null
  vitinho_ranked_at?: string | null
  will_rating?: number | null
  will_comment?: string | null
  will_track_order?: string[] | null
  will_ranked_at?: string | null
  created_at?: string
  updated_at?: string
}

interface StoreSchema {
  sessionUser: 'Vitinho' | 'Will' | null
  subnick: string
  ecoMode: boolean
  albumRankings: Record<string, AlbumRankingRecord>
}

const store = new Store<StoreSchema>({
  name: 'msn-privado-config',
  defaults: {
    sessionUser: null,
    subnick: 'Disponível no MSN Privado 🎮',
    ecoMode: false,
    albumRankings: {}
  }
})

let mainWindow: BrowserWindow | null = null
let rankerWindow: BrowserWindow | null = null
let djPlayerWindow: BrowserWindow | null = null
let djProgressTimer: ReturnType<typeof setInterval> | null = null
let djTargetState: {
  videoId: string | null
  isPlaying: boolean
  volume: number
  lastSeekTimestamp: number
  seekSeconds: number
} = {
  videoId: null,
  isPlaying: false,
  volume: 75,
  lastSeekTimestamp: 0,
  seekSeconds: 0
}
let djLoadedVideoId: string | null = null
let djAppliedSeekTimestamp = 0
let tray: Tray | null = null
let isQuitting = false
let localRendererServerUrl: string | null = null
let localHttpServer: HttpServer | null = null

/**
 * Servidor HTTP local em 127.0.0.1 para servir o Renderer no .exe empacotado.
 * Isso garante uma origem http://127.0.0.1 válida (em vez de file://), permitindo que
 * a API IFrame do YouTube funcione 100% sem bloqueio de origem (Error 150/153/postMessage).
 */
async function ensureLocalRendererServer(): Promise<string> {
  if (localRendererServerUrl) return localRendererServerUrl

  const rendererRoot = join(__dirname, '../renderer')
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ico': 'image/x-icon'
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const cleanUrl = (req.url || '/').split('?')[0].split('#')[0]
        const relPath = cleanUrl === '/' ? '/index.html' : cleanUrl
        const filePath = join(rendererRoot, relPath)
        const data = await readFile(filePath)
        const ext = extname(filePath).toLowerCase()
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        })
        res.end(data)
      } catch {
        try {
          const fallback = await readFile(join(rendererRoot, 'index.html'))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(fallback)
        } catch (err) {
          res.writeHead(404)
          res.end('Not found')
          console.error(err)
        }
      }
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 45781
      localHttpServer = server
      localRendererServerUrl = `http://127.0.0.1:${port}`
      resolve(localRendererServerUrl)
    })
  })
}

const supabaseUrl = (
  import.meta.env.VITE_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  ''
).replace(/\/$/, '')
const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

/**
 * Helper leve via fetch nativo para o Supabase PostgREST no processo Main
 * (Evita instanciar RealtimeClient/WebSocket no Node.js do Electron Main e economiza RAM)
 */
async function supabaseRestFetch<T>(
  pathAndQuery: string,
  options: RequestInit = {}
): Promise<T | null> {
  if (!supabaseUrl || !supabaseKey) return null
  const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    throw new Error(`Supabase REST status ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// ============================================================================
// 3. ÍCONE NATIVO DO MSN EM DATA URL (ZERO ARQUIVO EXTERNO OBRIGATÓRIO)
// ============================================================================
function createMsnTrayIcon(): Electron.NativeImage {
  // Ícone SVG clássico dos dois bonequinhos verde/azul do MSN
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4facfe"/>
        <stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
      <linearGradient id="buddyGreen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#76ff03"/>
        <stop offset="100%" stop-color="#33691e"/>
      </linearGradient>
      <linearGradient id="buddyBlue" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#40c4ff"/>
        <stop offset="100%" stop-color="#01579b"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="14" fill="url(#bg)"/>
    <circle cx="38" cy="20" r="8" fill="url(#buddyBlue)" stroke="#fff" stroke-width="2"/>
    <path d="M26 44 C26 32, 50 32, 50 44 Z" fill="url(#buddyBlue)" stroke="#fff" stroke-width="2"/>
    <circle cx="24" cy="24" r="9" fill="url(#buddyGreen)" stroke="#fff" stroke-width="2"/>
    <path d="M10 50 C10 36, 38 36, 38 50 Z" fill="url(#buddyGreen)" stroke="#fff" stroke-width="2"/>
  </svg>`
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
}

// ============================================================================
// 4. MOTOR DE ÁUDIO OCULTO DO DJ BOT (YOUTUBE WATCH PLAYER NATIVO SEM EMBED BLOCK)
// ============================================================================
function configureYouTubeHeaders(): void {
  const filter = {
    urls: ['*://*.googlevideo.com/*', '*://*.ytimg.com/*']
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    if (!requestHeaders['Referer']) {
      requestHeaders['Referer'] = 'https://www.youtube.com/'
    }
    callback({ requestHeaders })
  })
}

function ensureDjPlayerWindow(): BrowserWindow {
  if (djPlayerWindow && !djPlayerWindow.isDestroyed()) {
    return djPlayerWindow
  }

  djPlayerWindow = new BrowserWindow({
    width: 360,
    height: 240,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  djPlayerWindow.webContents.setAudioMuted(false)

  djPlayerWindow.on('closed', () => {
    djPlayerWindow = null
    djLoadedVideoId = null
  })

  if (!djProgressTimer) {
    djProgressTimer = setInterval(async () => {
      if (!djPlayerWindow || djPlayerWindow.isDestroyed() || !djTargetState.videoId) return
      try {
        const shouldSeek = djTargetState.lastSeekTimestamp > djAppliedSeekTimestamp
        const seekVal = djTargetState.seekSeconds
        if (shouldSeek) {
          djAppliedSeekTimestamp = djTargetState.lastSeekTimestamp
        }

        const targetVol = Math.max(0, Math.min(1, djTargetState.volume / 100))
        const shouldPlay = djTargetState.isPlaying

        const status = await djPlayerWindow.webContents.executeJavaScript(`
          (() => {
            try {
              const moviePlayer = document.getElementById('movie_player');
              if (moviePlayer && typeof moviePlayer.setPlaybackQualityRange === 'function') {
                moviePlayer.setPlaybackQualityRange('tiny', 'small');
              }
              const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
              if (skipBtn) skipBtn.click();

              const adShowing = Boolean(document.querySelector('.ad-showing'));
              const v = document.querySelector('video');
              if (!v) return null;

              if (adShowing && Number.isFinite(v.duration) && v.duration > 0) {
                v.currentTime = v.duration;
              }

              v.muted = false;
              v.volume = ${targetVol};

              if (${shouldSeek ? 'true' : 'false'} && !adShowing && Math.abs(v.currentTime - ${seekVal}) > 4) {
                v.currentTime = ${seekVal};
              }

              if (${shouldPlay ? 'true' : 'false'}) {
                if (v.paused && !v.ended) {
                  v.play().catch(() => {});
                }
              } else {
                if (!v.paused) {
                  v.pause();
                }
              }

              return {
                currentTime: adShowing ? 0 : Math.floor(v.currentTime || 0),
                duration: adShowing ? 0 : Math.floor(v.duration || 0),
                paused: v.paused,
                ended: !adShowing && v.ended && v.currentTime > 3
              };
            } catch (e) {
              return null;
            }
          })()
        `)

        if (status && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('djbot:time-update', {
            videoId: djTargetState.videoId,
            ...status
          })
        }
      } catch {
        // página ainda carregando
      }
    }, 500)
  }

  return djPlayerWindow
}

function syncDjBotPlayer(payload: {
  videoId: string | null
  isPlaying: boolean
  volume: number
  seekSeconds?: number
  seekTimestamp?: number
}): void {
  djTargetState.videoId = payload.videoId
  djTargetState.isPlaying = payload.isPlaying
  djTargetState.volume = payload.volume

  if (typeof payload.seekSeconds === 'number' && payload.seekTimestamp) {
    djTargetState.seekSeconds = payload.seekSeconds
    djTargetState.lastSeekTimestamp = payload.seekTimestamp
  }

  if (!payload.videoId) {
    if (djPlayerWindow && !djPlayerWindow.isDestroyed()) {
      djPlayerWindow.loadURL('about:blank').catch(() => {})
    }
    djLoadedVideoId = null
    return
  }

  const win = ensureDjPlayerWindow()
  if (djLoadedVideoId !== payload.videoId) {
    djLoadedVideoId = payload.videoId
    const startParam =
      payload.seekSeconds && payload.seekSeconds > 2 ? `&t=${Math.floor(payload.seekSeconds)}s` : ''
    win
      .loadURL(`https://www.youtube.com/watch?v=${payload.videoId}${startParam}`, {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      })
      .catch((err) => console.warn('[DJ Bot] Erro ao carregar vídeo:', err))
  }
}

// ============================================================================
// 5. CRIAÇÃO DA JANELA PRINCIPAL (MSN MESSENGER)
// ============================================================================
async function createMainWindow(): Promise<void> {
  const icon = createMsnTrayIcon()

  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Windows Live Messenger - Vitinho & Will (Gaming Edition)',
    icon,
    backgroundColor: '#d9ecff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // Mantém WebRTC e áudio vivos quando minimizado durante jogos
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Notifica o Renderer sobre visibilidade para congelar/restaurar <video> e economizar 100% de GPU nos jogos
  const notifyVisibility = (visible: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-visibility-changed', visible)
    }
  }

  mainWindow.on('minimize', () => notifyVisibility(false))
  mainWindow.on('hide', () => notifyVisibility(false))
  mainWindow.on('restore', () => notifyVisibility(true))
  mainWindow.on('show', () => notifyVisibility(true))
  mainWindow.on('focus', () => notifyVisibility(true))

  // Fechar para a bandeja (System Tray) ao clicar no "X"
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      notifyVisibility(false)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const baseUrl = await ensureLocalRendererServer()
    mainWindow.loadURL(baseUrl)
  }
}

// ============================================================================
// 6. CRIAÇÃO SOB DEMANDA DA SEGUNDA JANELA: RANKEADOR DE ÁLBUNS (1080x760)
// ============================================================================
async function openAlbumRankerWindow(): Promise<void> {
  if (rankerWindow && !rankerWindow.isDestroyed()) {
    if (rankerWindow.isMinimized()) rankerWindow.restore()
    rankerWindow.focus()
    return
  }

  const icon = createMsnTrayIcon()

  rankerWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'MSN Music — Rankeador de Álbuns (Vitinho vs Will)',
    icon,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  rankerWindow.on('ready-to-show', () => {
    rankerWindow?.show()
  })

  // Quando fechada pelo usuário, destrói a janela completamente para consumir 0 MB de RAM durante os jogos
  rankerWindow.on('closed', () => {
    rankerWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    rankerWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/album-ranker`)
  } else {
    const baseUrl = await ensureLocalRendererServer()
    rankerWindow.loadURL(`${baseUrl}/#/album-ranker`)
  }
}

// ============================================================================
// 7. SYSTEM TRAY (BANDEJA DO SISTEMA) E ATALHO GLOBAL DE MUTE (Ctrl+Shift+M)
// ============================================================================
function setupSystemTray(): void {
  const icon = createMsnTrayIcon()
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('MSN Messenger Privado (Vitinho & Will)')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir MSN Messenger',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    {
      label: 'Rankeador de Álbuns 🏆',
      click: () => {
        openAlbumRankerWindow()
      }
    },
    {
      label: 'Mutar / Desmutar Microfone (Ctrl+Shift+M)',
      click: () => {
        mainWindow?.webContents.send('global-mute-shortcut')
      }
    },
    { type: 'separator' },
    {
      label: 'Sair Completamente',
      click: () => {
        isQuitting = true
        if (rankerWindow && !rankerWindow.isDestroyed()) {
          rankerWindow.close()
        }
        if (djPlayerWindow && !djPlayerWindow.isDestroyed()) {
          djPlayerWindow.close()
        }
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function registerGlobalShortcuts(): void {
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-mute-shortcut')
    }
  })
}

// ============================================================================
// 8. INTEGRAÇÃO COM API PÚBLICA DE MÚSICA (iTunes Search API + Fallback Deezer)
// ============================================================================
async function searchAlbumsItunesAndDeezer(query: string): Promise<AlbumSearchResult[]> {
  const encoded = encodeURIComponent(query.trim())

  // 1. Tenta iTunes Search API primeiro
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encoded}&entity=album&limit=18`
    const response = await fetch(itunesUrl)
    if (response.ok) {
      const data = (await response.json()) as {
        results?: Array<{
          collectionId: number
          collectionName: string
          artistName: string
          artworkUrl100?: string
          releaseDate?: string
          trackCount?: number
        }>
      }

      if (data.results && data.results.length > 0) {
        return data.results.map((item) => ({
          albumId: `itunes-${item.collectionId}`,
          albumName: item.collectionName,
          artistName: item.artistName,
          artworkUrl: item.artworkUrl100
            ? item.artworkUrl100.replace('100x100bb', '600x600bb')
            : '',
          releaseYear: item.releaseDate ? item.releaseDate.slice(0, 4) : '',
          trackCount: item.trackCount || 0,
          provider: 'itunes'
        }))
      }
    }
  } catch (err) {
    console.warn('[AlbumRanker] Falha na busca iTunes, acionando fallback Deezer:', err)
  }

  // 2. Fallback para Deezer Public API
  try {
    const deezerUrl = `https://api.deezer.com/search/album?q=${encoded}&limit=18`
    const response = await fetch(deezerUrl)
    if (response.ok) {
      const data = (await response.json()) as {
        data?: Array<{
          id: number
          title: string
          cover_xl?: string
          cover_big?: string
          nb_tracks?: number
          artist?: { name?: string }
        }>
      }

      if (data.data && data.data.length > 0) {
        return data.data.map((item) => ({
          albumId: `deezer-${item.id}`,
          albumName: item.title,
          artistName: item.artist?.name || 'Artista Desconhecido',
          artworkUrl: item.cover_xl || item.cover_big || '',
          releaseYear: '',
          trackCount: item.nb_tracks || 0,
          provider: 'deezer'
        }))
      }
    }
  } catch (err) {
    console.error('[AlbumRanker] Erro também no fallback Deezer:', err)
  }

  return []
}

async function fetchAlbumTracks(albumId: string): Promise<{
  albumId: string
  albumName: string
  artistName: string
  artworkUrl: string
  releaseYear: string
  tracks: AlbumTrackItem[]
}> {
  if (albumId.startsWith('deezer-')) {
    const rawId = albumId.replace('deezer-', '')
    const res = await fetch(`https://api.deezer.com/album/${rawId}`)
    if (!res.ok) throw new Error('Não foi possível carregar o álbum na API Deezer.')
    const albumData = (await res.json()) as {
      id: number
      title: string
      cover_xl?: string
      cover_big?: string
      release_date?: string
      artist?: { name?: string }
      tracks?: {
        data?: Array<{
          id: number
          title: string
          duration: number
          track_position?: number
          preview?: string
        }>
      }
    }

    const tracks: AlbumTrackItem[] = (albumData.tracks?.data || []).map((t, idx) => ({
      trackId: `deezer-track-${t.id}`,
      trackNumber: t.track_position || idx + 1,
      trackName: t.title,
      durationMs: (t.duration || 0) * 1000,
      previewUrl: t.preview || undefined
    }))

    return {
      albumId,
      albumName: albumData.title,
      artistName: albumData.artist?.name || '',
      artworkUrl: albumData.cover_xl || albumData.cover_big || '',
      releaseYear: albumData.release_date ? albumData.release_date.slice(0, 4) : '',
      tracks
    }
  }

  // Padrão: iTunes Lookup API
  const rawId = albumId.replace('itunes-', '')
  const res = await fetch(`https://itunes.apple.com/lookup?id=${rawId}&entity=song`)
  if (!res.ok) throw new Error('Não foi possível carregar as faixas na iTunes API.')
  const data = (await res.json()) as {
    results?: Array<{
      wrapperType: string
      kind?: string
      collectionId?: number
      collectionName?: string
      artistName?: string
      artworkUrl100?: string
      releaseDate?: string
      trackId?: number
      trackName?: string
      trackNumber?: number
      trackTimeMillis?: number
      previewUrl?: string
    }>
  }

  const results = data.results || []
  const collection = results.find((r) => r.wrapperType === 'collection') || results[0]
  const songs = results.filter((r) => r.wrapperType === 'track' || r.kind === 'song')

  const tracks: AlbumTrackItem[] = songs.map((s, idx) => ({
    trackId: `itunes-track-${s.trackId || idx + 1}`,
    trackNumber: s.trackNumber || idx + 1,
    trackName: s.trackName || `Faixa ${idx + 1}`,
    durationMs: s.trackTimeMillis || 0,
    previewUrl: s.previewUrl || undefined
  }))

  return {
    albumId: `itunes-${rawId}`,
    albumName: collection?.collectionName || 'Álbum',
    artistName: collection?.artistName || 'Artista',
    artworkUrl: collection?.artworkUrl100
      ? collection.artworkUrl100.replace('100x100bb', '600x600bb')
      : '',
    releaseYear: collection?.releaseDate ? collection.releaseDate.slice(0, 4) : '',
    tracks
  }
}

// ============================================================================
// 9. RESOLVEDOR DO DJ BOT (SPOTIFY oEmbed / YOUTUBE / NOME DA MÚSICA -> VIDEO ID)
// ============================================================================
function extractYouTubeId(input: string): string | null {
  const regExp =
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i
  const match = input.match(regExp)
  return match ? match[1] : null
}

async function resolveDjBotTrack(queryOrUrl: string): Promise<{
  videoId: string
  title: string
  author: string
  durationSeconds: number
  thumbnail: string
}> {
  const trimmed = queryOrUrl.trim()
  let searchQuery = trimmed

  // 1. Se for link do Spotify, extrai título e artista via oEmbed oficial do Spotify
  if (trimmed.includes('open.spotify.com/')) {
    try {
      const oembedRes = await fetch(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(trimmed)}`
      )
      if (oembedRes.ok) {
        const oembedData = (await oembedRes.json()) as {
          title?: string
          author_name?: string
        }
        if (oembedData.title) {
          searchQuery = `${oembedData.title} ${oembedData.author_name || ''} official audio`.trim()
        }
      }
    } catch (err) {
      console.warn('[DJ Bot] Falha ao consultar oEmbed do Spotify, buscando direto:', err)
    }
  }

  // 2. Se já for link direto do YouTube com ID válido, busca metadados do vídeo
  const directYtId = extractYouTubeId(trimmed)
  if (directYtId) {
    try {
      const videoInfo = await ytSearch({ videoId: directYtId })
      return {
        videoId: directYtId,
        title: videoInfo.title || 'Faixa do YouTube',
        author: videoInfo.author?.name || 'YouTube',
        durationSeconds: videoInfo.seconds || 180,
        thumbnail: videoInfo.thumbnail || `https://i.ytimg.com/vi/${directYtId}/hqdefault.jpg`
      }
    } catch {
      return {
        videoId: directYtId,
        title: 'Faixa do YouTube',
        author: 'YouTube',
        durationSeconds: 180,
        thumbnail: `https://i.ytimg.com/vi/${directYtId}/hqdefault.jpg`
      }
    }
  }

  // 3. Busca por nome ou termo extraído do Spotify usando yt-search (prioriza faixas de áudio sem bloqueio de embed VEVO)
  const audioQuery = searchQuery.toLowerCase().includes('audio')
    ? searchQuery
    : `${searchQuery} official audio`
  const searchResult = await ytSearch(audioQuery)
  const videos = searchResult.videos || []
  const firstVideo = videos[0]
  if (!firstVideo) {
    throw new Error(`Nenhuma música encontrada para: "${queryOrUrl}"`)
  }

  return {
    videoId: firstVideo.videoId,
    title: firstVideo.title,
    author: firstVideo.author?.name || 'Artista',
    durationSeconds: firstVideo.seconds || 180,
    thumbnail: firstVideo.thumbnail || `https://i.ytimg.com/vi/${firstVideo.videoId}/hqdefault.jpg`
  }
}

// ============================================================================
// 10. HANDLERS IPC E AUTO-UPDATER
// ============================================================================
function registerIpcHandlers(): void {
  // Sessão e Configurações Locais
  ipcMain.handle('store:get-session', () => {
    return {
      sessionUser: store.get('sessionUser'),
      subnick: store.get('subnick'),
      ecoMode: store.get('ecoMode')
    }
  })

  ipcMain.handle(
    'store:set-session',
    (_event, payload: { sessionUser: 'Vitinho' | 'Will' | null; subnick?: string; ecoMode?: boolean }) => {
      store.set('sessionUser', payload.sessionUser)
      if (typeof payload.subnick === 'string') store.set('subnick', payload.subnick)
      if (typeof payload.ecoMode === 'boolean') store.set('ecoMode', payload.ecoMode)
      return true
    }
  )

  // Abrir a Segunda Janela Dedicada do Rankeador de Álbuns (1080x760)
  ipcMain.handle('open-album-ranker', () => {
    openAlbumRankerWindow()
    return true
  })

  // Tremer a janela física do Electron por 600ms ("Chamar Atenção / Nudge")
  ipcMain.handle('nudge-window', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()

    const [startX, startY] = mainWindow.getPosition()
    const durationMs = 600
    const intervalMs = 30
    const steps = Math.floor(durationMs / intervalMs)

    for (let i = 0; i < steps; i++) {
      if (!mainWindow || mainWindow.isDestroyed()) break
      const offsetX = (Math.random() - 0.5) * 22
      const offsetY = (Math.random() - 0.5) * 18
      mainWindow.setPosition(Math.round(startX + offsetX), Math.round(startY + offsetY))
      await new Promise((r) => setTimeout(r, intervalMs))
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setPosition(startX, startY)
    }
    return true
  })

  // Notificação Nativa do Windows ("Will acabou de entrar", etc.)
  ipcMain.handle(
    'show-native-notification',
    (_event, payload: { title: string; body: string }) => {
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: payload.title,
          body: payload.body,
          icon: createMsnTrayIcon()
        })
        notif.on('click', () => {
          mainWindow?.show()
          mainWindow?.focus()
        })
        notif.show()
      }
      return true
    }
  )

  // Seletor Customizado de Janela/Tela (desktopCapturer)
  ipcMain.handle('get-desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 360, height: 202 },
      fetchWindowIcons: true
    })

    return sources.map((src) => ({
      id: src.id,
      name: src.name,
      display_id: src.display_id,
      thumbnailDataUrl: src.thumbnail.toDataURL(),
      appIconDataUrl: src.appIcon ? src.appIcon.toDataURL() : null,
      isScreen: src.id.startsWith('screen:')
    }))
  })

  // Resolvedor do DJ Bot (Nome / YouTube / Spotify)
  ipcMain.handle('resolve-dj-track', async (_event, queryOrUrl: string) => {
    return await resolveDjBotTrack(queryOrUrl)
  })

  // Sincronizar reprodução real do DJ Bot no processo Main
  ipcMain.handle(
    'djbot:sync-player',
    (
      _event,
      payload: {
        videoId: string | null
        isPlaying: boolean
        volume: number
        seekSeconds?: number
        seekTimestamp?: number
      }
    ) => {
      syncDjBotPlayer(payload)
      return true
    }
  )

  // Busca de Álbuns (iTunes Search API + Fallback Deezer)
  ipcMain.handle('albums:search', async (_event, query: string) => {
    return await searchAlbumsItunesAndDeezer(query)
  })

  // Buscar Faixas Oficiais do Álbum (iTunes Lookup / Deezer Tracks)
  ipcMain.handle('albums:get-tracks', async (_event, albumId: string) => {
    return await fetchAlbumTracks(albumId)
  })

  // Listar todos os Rankings (Híbrido: Supabase + electron-store local)
  ipcMain.handle('albums:list-rankings', async () => {
    const localMap = store.get('albumRankings') || {}

    if (supabaseUrl && supabaseKey) {
      try {
        const data = await supabaseRestFetch<AlbumRankingRecord[]>(
          'album_rankings?select=*&order=updated_at.desc'
        )

        if (Array.isArray(data)) {
          const mergedMap: Record<string, AlbumRankingRecord> = { ...localMap }
          for (const row of data) {
            mergedMap[row.album_id] = row
          }
          store.set('albumRankings', mergedMap)
          return Object.values(mergedMap).sort((a, b) =>
            (b.updated_at || '').localeCompare(a.updated_at || '')
          )
        }
      } catch (err) {
        console.warn('[AlbumRanker] Usando cache local electron-store (offline/sem Supabase):', err)
      }
    }

    return Object.values(localMap).sort((a, b) =>
      (b.updated_at || '').localeCompare(a.updated_at || '')
    )
  })

  // Salvar Ranking de Álbum (Supabase + electron-store + Notificação P2P para o Amigo)
  ipcMain.handle(
    'albums:save-ranking',
    async (
      _event,
      payload: {
        albumId: string
        albumName: string
        artistName: string
        artworkUrl: string
        releaseYear?: string
        tracksMetadata: AlbumTrackItem[]
        user: 'Vitinho' | 'Will'
        rating: number
        comment: string
        trackOrder: string[]
      }
    ) => {
      const now = new Date().toISOString()
      const localMap = store.get('albumRankings') || {}
      const existing = localMap[payload.albumId]

      const record: AlbumRankingRecord = {
        album_id: payload.albumId,
        album_name: payload.albumName,
        artist_name: payload.artistName,
        artwork_url: payload.artworkUrl,
        release_year: payload.releaseYear || existing?.release_year || '',
        tracks_metadata:
          payload.tracksMetadata.length > 0
            ? payload.tracksMetadata
            : existing?.tracks_metadata || [],
        vitinho_rating:
          payload.user === 'Vitinho' ? payload.rating : existing?.vitinho_rating ?? null,
        vitinho_comment:
          payload.user === 'Vitinho' ? payload.comment : existing?.vitinho_comment ?? null,
        vitinho_track_order:
          payload.user === 'Vitinho' ? payload.trackOrder : existing?.vitinho_track_order ?? null,
        vitinho_ranked_at:
          payload.user === 'Vitinho' ? now : existing?.vitinho_ranked_at ?? null,
        will_rating: payload.user === 'Will' ? payload.rating : existing?.will_rating ?? null,
        will_comment: payload.user === 'Will' ? payload.comment : existing?.will_comment ?? null,
        will_track_order:
          payload.user === 'Will' ? payload.trackOrder : existing?.will_track_order ?? null,
        will_ranked_at: payload.user === 'Will' ? now : existing?.will_ranked_at ?? null,
        created_at: existing?.created_at || now,
        updated_at: now
      }

      // 1. Salva imediatamente no cache local electron-store
      localMap[payload.albumId] = record
      store.set('albumRankings', localMap)

      // 2. Salva na nuvem (Supabase PostgREST) se configurado
      if (supabaseUrl && supabaseKey) {
        try {
          const upsertData: Record<string, unknown> = {
            album_id: record.album_id,
            album_name: record.album_name,
            artist_name: record.artist_name,
            artwork_url: record.artwork_url,
            release_year: record.release_year,
            tracks_metadata: record.tracks_metadata
          }
          if (payload.user === 'Vitinho') {
            upsertData.vitinho_rating = payload.rating
            upsertData.vitinho_comment = payload.comment
            upsertData.vitinho_track_order = payload.trackOrder
            upsertData.vitinho_ranked_at = now
          } else {
            upsertData.will_rating = payload.rating
            upsertData.will_comment = payload.comment
            upsertData.will_track_order = payload.trackOrder
            upsertData.will_ranked_at = now
          }

          const rows = await supabaseRestFetch<AlbumRankingRecord[]>(
            'album_rankings?on_conflict=album_id',
            {
              method: 'POST',
              headers: {
                Prefer: 'resolution=merge-duplicates,return=representation'
              },
              body: JSON.stringify(upsertData)
            }
          )

          if (Array.isArray(rows) && rows[0]) {
            localMap[payload.albumId] = rows[0]
            store.set('albumRankings', localMap)
          }
        } catch (err) {
          console.warn('[AlbumRanker] Salvo localmente; sincronização Supabase falhou:', err)
        }
      }

      // 3. Avisa a janela principal para disparar o alerta no RTCDataChannel P2P para o amigo
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('album-ranked-broadcast', {
          user: payload.user,
          albumId: payload.albumId,
          albumName: payload.albumName,
          artistName: payload.artistName,
          rating: payload.rating
        })
      }

      return localMap[payload.albumId]
    }
  )

  // Enviar todas as faixas de um álbum do Rankeador para a fila do DJ Bot na janela principal
  ipcMain.handle(
    'albums:queue-in-djbot',
    (
      _event,
      payload: {
        albumName: string
        artistName: string
        tracks: Array<{ trackName: string }>
      }
    ) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('djbot-queue-album', payload)
        mainWindow.show()
        mainWindow.focus()
      }
      return true
    }
  )

  // Auto-Updater (GitHub Releases)
  ipcMain.handle('app:get-version', () => app.getVersion())

  ipcMain.handle('updater:check', async () => {
    try {
      if (is.dev) {
        mainWindow?.webContents.send('updater:status', {
          status: 'up-to-date',
          message: 'Modo Desenvolvimento (v' + app.getVersion() + ' atualizada)'
        })
        return { ok: true, dev: true }
      }
      const res = await autoUpdater.checkForUpdates()
      return { ok: true, updateInfo: res?.updateInfo }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao verificar atualização'
      mainWindow?.webContents.send('updater:status', {
        status: 'error',
        message: msg
      })
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('updater:quit-and-install', () => {
    isQuitting = true
    autoUpdater.quitAndInstall()
  })
}

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const sendStatus = (payload: Record<string, unknown>): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', payload)
    }
  }

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ status: 'checking', message: 'Procurando atualizações no GitHub...' })
  })

  autoUpdater.on('update-available', (info) => {
    sendStatus({
      status: 'available',
      version: info.version,
      message: `Nova versão v${info.version} encontrada! Baixando...`
    })
  })

  autoUpdater.on('update-not-available', () => {
    sendStatus({
      status: 'up-to-date',
      message: `Você já está na versão mais recente (v${app.getVersion()}).`
    })
  })

  autoUpdater.on('download-progress', (progressObj) => {
    sendStatus({
      status: 'downloading',
      percent: Math.round(progressObj.percent),
      message: `Baixando atualização: ${Math.round(progressObj.percent)}%`
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({
      status: 'downloaded',
      version: info.version,
      message: `Atualização v${info.version} pronta para instalar!`
    })
  })

  autoUpdater.on('error', (err) => {
    sendStatus({
      status: 'error',
      message: `Erro no Auto-Update: ${err.message}`
    })
  })
}

// ============================================================================
// 11. CICLO DE VIDA DO APP ELECTRON
// ============================================================================
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vitinhowill.msnprivadop2p')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  configureYouTubeHeaders()
  registerIpcHandlers()
  setupAutoUpdater()
  createMainWindow()
  setupSystemTray()
  registerGlobalShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (localHttpServer) {
    localHttpServer.close()
    localHttpServer = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit()
  }
})
