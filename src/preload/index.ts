import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface DesktopSourceItem {
  id: string
  name: string
  display_id: string
  thumbnailDataUrl: string
  appIconDataUrl: string | null
  isScreen: boolean
}

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

const msnApi = {
  // Sessão local, dispositivos e histórico de mensagens
  getSession: (): Promise<{
    sessionUser: 'Vitinho' | 'Will' | null
    subnick: string
    ecoMode: boolean
    audioDeviceId: string
    videoDeviceId: string
    chatMessages: StoredChatMessage[]
  }> => ipcRenderer.invoke('store:get-session'),

  setSession: (payload: {
    sessionUser?: 'Vitinho' | 'Will' | null
    subnick?: string
    ecoMode?: boolean
    audioDeviceId?: string
    videoDeviceId?: string
  }): Promise<boolean> => ipcRenderer.invoke('store:set-session', payload),

  saveChatMessages: (messages: StoredChatMessage[]): Promise<boolean> =>
    ipcRenderer.invoke('store:save-chat-messages', messages),

  // Janela do Rankeador de Álbuns (1080x760)
  openAlbumRanker: (): Promise<boolean> => ipcRenderer.invoke('open-album-ranker'),

  // Tela Cheia (Fullscreen) para Ligações
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-fullscreen'),
  setFullscreen: (fullscreen: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:set-fullscreen', fullscreen),
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean): void =>
      callback(isFullscreen)
    ipcRenderer.on('window-fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('window-fullscreen-changed', handler)
  },

  // Chamar Atenção (Tremer janela física)
  nudgeWindow: (): Promise<boolean> => ipcRenderer.invoke('nudge-window'),

  // Notificação Nativa do Windows
  showNativeNotification: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke('show-native-notification', { title, body }),

  // Fontes de Captura de Tela / Janela (desktopCapturer)
  getDesktopSources: (): Promise<DesktopSourceItem[]> =>
    ipcRenderer.invoke('get-desktop-sources'),

  // DJ Bot (YouTube / Spotify oEmbed / yt-search + Motor de Áudio Nativo)
  resolveDjTrack: (
    queryOrUrl: string
  ): Promise<{
    videoId: string
    title: string
    author: string
    durationSeconds: number
    thumbnail: string
  }> => ipcRenderer.invoke('resolve-dj-track', queryOrUrl),

  syncDjPlayer: (payload: {
    videoId: string | null
    isPlaying: boolean
    volume: number
    seekSeconds?: number
    seekTimestamp?: number
  }): Promise<boolean> => ipcRenderer.invoke('djbot:sync-player', payload),

  onDjBotTimeUpdate: (
    callback: (payload: {
      videoId: string
      currentTime: number
      duration: number
      paused: boolean
      ended: boolean
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        videoId: string
        currentTime: number
        duration: number
        paused: boolean
        ended: boolean
      }
    ): void => callback(payload)
    ipcRenderer.on('djbot:time-update', handler)
    return () => ipcRenderer.removeListener('djbot:time-update', handler)
  },

  // Rankeador de Álbuns (iTunes Search API + Deezer Fallback + Persistência Híbrida)
  searchAlbums: (query: string): Promise<AlbumSearchResult[]> =>
    ipcRenderer.invoke('albums:search', query),

  getAlbumTracks: (
    albumId: string
  ): Promise<{
    albumId: string
    albumName: string
    artistName: string
    artworkUrl: string
    releaseYear: string
    tracks: AlbumTrackItem[]
  }> => ipcRenderer.invoke('albums:get-tracks', albumId),

  listAlbumRankings: (): Promise<AlbumRankingRecord[]> =>
    ipcRenderer.invoke('albums:list-rankings'),

  saveAlbumRanking: (payload: {
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
  }): Promise<AlbumRankingRecord> => ipcRenderer.invoke('albums:save-ranking', payload),

  queueAlbumInDjBot: (payload: {
    albumName: string
    artistName: string
    tracks: Array<{ trackName: string }>
  }): Promise<boolean> => ipcRenderer.invoke('albums:queue-in-djbot', payload),

  // Auto-Updater e Versão
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: (): Promise<{ ok: boolean; dev?: boolean; error?: string }> =>
    ipcRenderer.invoke('updater:check'),
  quitAndInstallUpdate: (): Promise<void> => ipcRenderer.invoke('updater:quit-and-install'),

  // Listeners de Eventos vindos do Processo Main
  onWindowVisibilityChanged: (callback: (visible: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, visible: boolean): void => callback(visible)
    ipcRenderer.on('window-visibility-changed', handler)
    return () => ipcRenderer.removeListener('window-visibility-changed', handler)
  },

  onGlobalMuteShortcut: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('global-mute-shortcut', handler)
    return () => ipcRenderer.removeListener('global-mute-shortcut', handler)
  },

  onAlbumRankedBroadcast: (
    callback: (payload: {
      user: 'Vitinho' | 'Will'
      albumId: string
      albumName: string
      artistName: string
      rating: number
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        user: 'Vitinho' | 'Will'
        albumId: string
        albumName: string
        artistName: string
        rating: number
      }
    ): void => callback(payload)
    ipcRenderer.on('album-ranked-broadcast', handler)
    return () => ipcRenderer.removeListener('album-ranked-broadcast', handler)
  },

  onDjBotQueueAlbum: (
    callback: (payload: {
      albumName: string
      artistName: string
      tracks: Array<{ trackName: string }>
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        albumName: string
        artistName: string
        tracks: Array<{ trackName: string }>
      }
    ): void => callback(payload)
    ipcRenderer.on('djbot-queue-album', handler)
    return () => ipcRenderer.removeListener('djbot-queue-album', handler)
  },

  onUpdaterStatus: (
    callback: (payload: {
      status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
      version?: string
      percent?: number
      message: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
        version?: string
        percent?: number
        message: string
      }
    ): void => callback(payload)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },

  // Captura Nativa de Áudio Loopback (WASAPI com exclusão ou inclusão por processo)
  startLoopbackCapture: (options?: {
    mode?: 'include' | 'exclude'
    targetPid?: number
    hwnd?: number
  }): Promise<boolean> => ipcRenderer.invoke('loopback:start', options),
  stopLoopbackCapture: (): Promise<boolean> => ipcRenderer.invoke('loopback:stop'),
  onLoopbackAudioChunk: (callback: (chunk: Uint8Array) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: Uint8Array): void => callback(chunk)
    ipcRenderer.on('loopback:audio-chunk', handler)
    return () => ipcRenderer.removeListener('loopback:audio-chunk', handler)
  },
  getWindowsBuild: (): Promise<number> => ipcRenderer.invoke('system:get-windows-build'),
  onBeforeQuit: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('app:before-quit', handler)
    return () => ipcRenderer.removeListener('app:before-quit', handler)
  },
  sendBeforeQuitDone: (): void => {
    ipcRenderer.send('app:before-quit-done')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('msnApi', msnApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (fallback quando contextIsolation = false)
  window.electron = electronAPI
  // @ts-ignore (fallback quando contextIsolation = false)
  window.msnApi = msnApi
}
