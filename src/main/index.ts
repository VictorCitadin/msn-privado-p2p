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
import os from 'os'
import { createServer, Server as HttpServer } from 'http'
import { existsSync, copyFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { execFile, spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import Store from 'electron-store'
import ytSearch from 'yt-search'

// ============================================================================
// 1. FLAGS CRÍTICAS DE HARDWARE, MEMÓRIA E ZERO ECO (ANTES DO app.whenReady)
// ============================================================================
app.commandLine.appendSwitch(
  'enable-features',
  'WebRtcAllowInputVolumeAdjustment,PulseaudioLoopbackForScreenShare,ChromeWideEchoCancellation'
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

export interface StoredChatMessage {
  id: string
  sender: 'Vitinho' | 'Will'
  text?: string
  imageDataUrl?: string
  isSystem?: boolean
  timestamp: string
}

interface StoreSchema {
  sessionUser: 'Vitinho' | 'Will' | null
  subnick: string
  ecoMode: boolean
  audioDeviceId: string
  videoDeviceId: string
  chatMessages: StoredChatMessage[]
  albumRankings: Record<string, AlbumRankingRecord>
}

const store = new Store<StoreSchema>({
  name: 'msn-privado-config',
  defaults: {
    sessionUser: null,
    subnick: '',
    ecoMode: false,
    audioDeviceId: '',
    videoDeviceId: '',
    chatMessages: [],
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
let loopbackProcess: ChildProcessWithoutNullStreams | null = null

function stopLoopbackProcess(): void {
  if (loopbackProcess) {
    try {
      loopbackProcess.kill()
    } catch {}
    loopbackProcess = null
  }
}
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
// 3. ÍCONE ANOS 2000 NATIVO EM PNG/ICO (BARRA DE TAREFAS + BANDEJA DO SISTEMA)
// ============================================================================
const MSN_2000S_ICON_PNG64 =
  'data:image/png;base64,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'

const MSN_2000S_ICON_PNG32 =
  'data:image/png;base64,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'

function resolveBundledIconPath(fileName: 'icon.ico' | 'tray.ico'): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', fileName),
    join(process.resourcesPath || '', 'resources', fileName),
    join(__dirname, `../../resources/${fileName}`),
    join(__dirname, `../../build/${fileName}`)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function getFreshUserDataIconPath(kind: 'app' | 'tray'): string | null {
  try {
    const src = resolveBundledIconPath(kind === 'tray' ? 'tray.ico' : 'icon.ico')
    if (!src) return null
    const dest = join(
      app.getPath('userData'),
      kind === 'tray' ? 'vitinho-will-tray-v3.ico' : 'vitinho-will-icon-v3.ico'
    )
    copyFileSync(src, dest)
    return dest
  } catch {
    return resolveBundledIconPath(kind === 'tray' ? 'tray.ico' : 'icon.ico')
  }
}

function createMsnTrayIcon(): Electron.NativeImage {
  const icoPath = getFreshUserDataIconPath('app') || resolveBundledIconPath('icon.ico')
  if (icoPath) {
    try {
      const img = nativeImage.createFromPath(icoPath)
      if (!img.isEmpty()) return img
    } catch {}
  }
  return nativeImage.createFromDataURL(MSN_2000S_ICON_PNG64)
}

function createMsnTraySmallIcon(): Electron.NativeImage | string {
  const trayIcoPath = getFreshUserDataIconPath('tray') || resolveBundledIconPath('tray.ico')
  if (trayIcoPath) {
    return trayIcoPath
  }
  const img = nativeImage.createFromDataURL(MSN_2000S_ICON_PNG32)
  return img.resize({ width: 16, height: 16 })
}

function repairWindowsShortcutsAndTrayCache(): void {
  if (process.platform !== 'win32' || is.dev) return
  const appIcoPath = getFreshUserDataIconPath('app')
  if (!appIcoPath) return

  const exePath = process.execPath
  const psScript = `
    $ErrorActionPreference = 'SilentlyContinue'
    $exePath = '${exePath.replace(/'/g, "''")}'
    $icoPath = '${appIcoPath.replace(/'/g, "''")}'

    # 1. Remove entrada de bandeja corrompida/vazia do cache do Windows 11 (se nao tiver IconSnapshot)
    Get-ChildItem 'HKCU:\\Control Panel\\NotifyIconSettings' | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ($p.ExecutablePath -like '*MSNMessengerPrivado.exe*' -and -not $p.IconSnapshot) {
        Remove-Item $_.PSPath -Recurse -Force
      }
    }

    # 2. Atualiza atalhos do Menu Iniciar e Area de Trabalho para 'Vitinho e Will' com icone anos 2000 dedicado
    $startMenuDir = [Environment]::GetFolderPath('Programs')
    $desktopDir = [Environment]::GetFolderPath('Desktop')
    $oldStart = Join-Path $startMenuDir 'MSN Messenger Privado (Vitinho & Will).lnk'
    $oldDesktop = Join-Path $desktopDir 'MSN Messenger Privado (Vitinho & Will).lnk'
    if (Test-Path $oldStart) { Remove-Item $oldStart -Force }
    if (Test-Path $oldDesktop) { Remove-Item $oldDesktop -Force }

    $wsh = New-Object -ComObject WScript.Shell
    foreach ($dir in @($startMenuDir, $desktopDir)) {
      $lnkPath = Join-Path $dir 'Vitinho e Will.lnk'
      $s = $wsh.CreateShortcut($lnkPath)
      $s.TargetPath = $exePath
      $s.WorkingDirectory = Split-Path $exePath
      $s.IconLocation = "$icoPath,0"
      $s.Description = 'Vitinho e Will'
      $s.Save()
    }
  `

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    () => {
      const trayIco = createMsnTraySmallIcon()
      try {
        tray?.setImage(trayIco)
      } catch {}
    }
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
              const v = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
              if (!v) return null;

              // Garante que qualquer outro elemento <video> ou <audio> secundário na página do YouTube fique 100% pausado/mutado
              document.querySelectorAll('video, audio').forEach((el) => {
                if (el !== v) {
                  el.muted = true;
                  try { el.pause(); } catch {}
                }
              });

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
    title: 'Vitinho e Will',
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

  mainWindow.setIcon(icon)

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

  const notifyFullscreen = (isFull: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-fullscreen-changed', isFull)
    }
  }

  mainWindow.on('enter-full-screen', () => notifyFullscreen(true))
  mainWindow.on('leave-full-screen', () => notifyFullscreen(false))

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

  mainWindow.webContents.on('render-process-gone', () => {
    console.warn('[Main] Render process gone, finalizando captura loopback...')
    stopLoopbackProcess()
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
    title: 'Vitinho e Will — Rankeador de Álbuns',
    icon,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  rankerWindow.setIcon(icon)

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
  const icon = createMsnTraySmallIcon()
  tray = new Tray(icon)
  try {
    tray.setImage(icon)
  } catch {}
  setTimeout(() => {
    try {
      tray?.setImage(createMsnTraySmallIcon())
    } catch {}
  }, 800)
  tray.setToolTip('Vitinho e Will')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir Vitinho e Will',
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
        if (rankerWindow && !rankerWindow.isDestroyed()) {
          rankerWindow.destroy()
        }
        if (djPlayerWindow && !djPlayerWindow.isDestroyed()) {
          djPlayerWindow.destroy()
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
  // Sessão, Histórico de Mensagens e Dispositivos Locais
  ipcMain.handle('store:get-session', () => {
    let savedSubnick = store.get('subnick') || ''
    if (savedSubnick === 'Disponível no MSN Privado 🎮') {
      savedSubnick = ''
      store.set('subnick', '')
    }
    return {
      sessionUser: store.get('sessionUser'),
      subnick: savedSubnick,
      ecoMode: store.get('ecoMode'),
      audioDeviceId: store.get('audioDeviceId') || '',
      videoDeviceId: store.get('videoDeviceId') || '',
      chatMessages: store.get('chatMessages') || []
    }
  })

  ipcMain.handle(
    'store:set-session',
    (
      _event,
      payload: {
        sessionUser: 'Vitinho' | 'Will' | null
        subnick?: string
        ecoMode?: boolean
        audioDeviceId?: string
        videoDeviceId?: string
      }
    ) => {
      if (payload.sessionUser !== undefined) {
        store.set('sessionUser', payload.sessionUser)
      }
      if (typeof payload.subnick === 'string') {
        const cleanSub = payload.subnick === 'Disponível no MSN Privado 🎮' ? '' : payload.subnick
        store.set('subnick', cleanSub)
      }
      if (typeof payload.ecoMode === 'boolean') store.set('ecoMode', payload.ecoMode)
      if (typeof payload.audioDeviceId === 'string')
        store.set('audioDeviceId', payload.audioDeviceId)
      if (typeof payload.videoDeviceId === 'string')
        store.set('videoDeviceId', payload.videoDeviceId)
      return true
    }
  )

  ipcMain.handle('store:save-chat-messages', (_event, messages: StoredChatMessage[]) => {
    if (Array.isArray(messages)) {
      const sanitized = messages.slice(-300).map((m) => ({
        id: m.id,
        sender: m.sender,
        text: m.text,
        imageDataUrl: m.imageDataUrl,
        isSystem: m.isSystem,
        timestamp: m.timestamp
      }))
      store.set('chatMessages', sanitized)
    }
    return true
  })

  // Abrir a Segunda Janela Dedicada do Rankeador de Álbuns (1080x760)
  ipcMain.handle('open-album-ranker', () => {
    openAlbumRankerWindow()
    return true
  })

  // Alternar Tela Cheia (Fullscreen) na Janela Principal durante Ligações
  ipcMain.handle('window:toggle-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const nextState = !mainWindow.isFullScreen()
    mainWindow.setFullScreen(nextState)
    mainWindow.webContents.send('window-fullscreen-changed', nextState)
    return nextState
  })

  ipcMain.handle('window:set-fullscreen', (_event, fullscreen: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.setFullScreen(Boolean(fullscreen))
    mainWindow.webContents.send('window-fullscreen-changed', Boolean(fullscreen))
    return Boolean(fullscreen)
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

  function getWindowsBuild(): number {
    if (process.platform !== 'win32') return 0
    const rel = os.release()
    const parts = rel.split('.')
    return parts.length >= 3 ? parseInt(parts[2], 10) : 0
  }

  ipcMain.handle('system:get-windows-build', () => getWindowsBuild())

  // Captura Nativa de Áudio Loopback (WASAPI com exclusão ou inclusão por processo - Estilo Discord)
  ipcMain.handle(
    'loopback:start',
    async (
      event,
      options?: { mode?: 'include' | 'exclude'; targetPid?: number; hwnd?: number }
    ) => {
      stopLoopbackProcess()

      const winBuild = getWindowsBuild()
      if (winBuild > 0 && winBuild < 20348) {
        console.warn(
          `[Loopback] Versão do Windows build ${winBuild} não suporta Process Loopback nativo (requer >= 20348).`
        )
        return false
      }

      const exeName = 'loopback-capture.exe'
      const possiblePaths = [
        join(app.getAppPath(), 'resources', exeName),
        join(process.resourcesPath, exeName),
        join(process.resourcesPath, 'resources', exeName),
        join(__dirname, '../../resources', exeName),
        join(__dirname, '../resources', exeName)
      ]
      const exePath = possiblePaths.find((p) => existsSync(p))
      if (!exePath) {
        console.warn(
          '[Loopback] Executável loopback-capture.exe não encontrado nos caminhos:',
          possiblePaths
        )
        return false
      }

      try {
        const mode = options?.mode === 'include' ? 'include' : 'exclude'
        const spawnArgs = ['--mode', mode, '--parent-pid', String(process.pid)]
        if (options?.hwnd) {
          spawnArgs.push('--hwnd', String(options.hwnd))
        } else if (options?.targetPid) {
          spawnArgs.push('--pid', String(options.targetPid))
        } else {
          spawnArgs.push('--pid', String(process.pid))
        }

        console.log(`[Loopback] Iniciando loopback-capture.exe [${spawnArgs.join(' ')}]: ${exePath}`)
        const child = spawn(exePath, spawnArgs, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })

        loopbackProcess = child

        child.stdout.on('data', (chunk: Buffer) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('loopback:audio-chunk', chunk)
          }
        })

        child.on('exit', (code) => {
          console.log('[Loopback] Processo encerrado com código:', code)
          if (loopbackProcess === child) {
            loopbackProcess = null
          }
        })

        child.on('error', (err) => {
          console.error('[Loopback] Erro no processo filho:', err)
          if (loopbackProcess === child) {
            loopbackProcess = null
          }
        })

        return new Promise<boolean>((resolve) => {
          let settled = false
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true
              console.warn('[Loopback] Timeout de 3.5s aguardando LOOPBACK_READY.')
              resolve(false)
            }
          }, 3500)

          child.stderr.on('data', (data: Buffer) => {
            const msg = data.toString('utf8')
            console.log('[Loopback STDERR]', msg)
            if (msg.includes('LOOPBACK_READY')) {
              if (!settled) {
                settled = true
                clearTimeout(timeout)
                resolve(true)
              }
            } else if (msg.includes('LOOPBACK_ERROR')) {
              if (!settled) {
                settled = true
                clearTimeout(timeout)
                stopLoopbackProcess()
                resolve(false)
              }
            }
          })
        })
      } catch (err) {
        console.error('[Loopback] Falha ao fazer spawn de loopback-capture.exe:', err)
        return false
      }
    }
  )

  ipcMain.handle('loopback:stop', async () => {
    stopLoopbackProcess()
    return true
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
// 11. CICLO DE VIDA DO APP ELECTRON (COM SINGLE INSTANCE LOCK)
// ============================================================================
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })

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
    repairWindowsShortcutsAndTrayCache()
    registerGlobalShortcuts()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

app.on('before-quit', (e) => {
  if (isQuitting) {
    stopLoopbackProcess()
    try {
      tray?.destroy()
      tray = null
    } catch {}
    return
  }

  // Notifica o renderer para realizar untrack no Supabase e enviar hangup/room-state limpo
  if (mainWindow && !mainWindow.isDestroyed()) {
    e.preventDefault()
    isQuitting = true
    mainWindow.webContents.send('app:before-quit')
    const forceQuitTimer = setTimeout(() => {
      stopLoopbackProcess()
      app.quit()
    }, 800)

    ipcMain.once('app:before-quit-done', () => {
      clearTimeout(forceQuitTimer)
      stopLoopbackProcess()
      app.quit()
    })
  } else {
    isQuitting = true
    stopLoopbackProcess()
    try {
      tray?.destroy()
      tray = null
    } catch {}
  }
})

app.on('will-quit', () => {
  stopLoopbackProcess()
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
