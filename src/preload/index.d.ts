import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  DesktopSourceItem,
  AlbumTrackItem,
  AlbumSearchResult,
  AlbumRankingRecord,
  StoredChatMessage
} from './index'

export interface MsnBridgeApi {
  getSession: () => Promise<{
    sessionUser: 'Vitinho' | 'Will' | null
    subnick: string
    ecoMode: boolean
    audioDeviceId: string
    videoDeviceId: string
    chatMessages: StoredChatMessage[]
  }>
  setSession: (payload: {
    sessionUser?: 'Vitinho' | 'Will' | null
    subnick?: string
    ecoMode?: boolean
    audioDeviceId?: string
    videoDeviceId?: string
  }) => Promise<boolean>
  saveChatMessages: (messages: StoredChatMessage[]) => Promise<boolean>
  openAlbumRanker: () => Promise<boolean>
  toggleFullscreen: () => Promise<boolean>
  setFullscreen: (fullscreen: boolean) => Promise<boolean>
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void
  nudgeWindow: () => Promise<boolean>
  showNativeNotification: (title: string, body: string) => Promise<boolean>
  getDesktopSources: () => Promise<DesktopSourceItem[]>
  resolveDjTrack: (queryOrUrl: string) => Promise<{
    videoId: string
    title: string
    author: string
    durationSeconds: number
    thumbnail: string
  }>
  syncDjPlayer: (payload: {
    videoId: string | null
    isPlaying: boolean
    volume: number
    seekSeconds?: number
    seekTimestamp?: number
  }) => Promise<boolean>
  onDjBotTimeUpdate: (
    callback: (payload: {
      videoId: string
      currentTime: number
      duration: number
      paused: boolean
      ended: boolean
    }) => void
  ) => () => void
  searchAlbums: (query: string) => Promise<AlbumSearchResult[]>
  getAlbumTracks: (albumId: string) => Promise<{
    albumId: string
    albumName: string
    artistName: string
    artworkUrl: string
    releaseYear: string
    tracks: AlbumTrackItem[]
  }>
  listAlbumRankings: () => Promise<AlbumRankingRecord[]>
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
  }) => Promise<AlbumRankingRecord>
  queueAlbumInDjBot: (payload: {
    albumName: string
    artistName: string
    tracks: Array<{ trackName: string }>
  }) => Promise<boolean>
  getAppVersion: () => Promise<string>
  checkForUpdates: () => Promise<{ ok: boolean; dev?: boolean; error?: string }>
  quitAndInstallUpdate: () => Promise<void>
  onWindowVisibilityChanged: (callback: (visible: boolean) => void) => () => void
  onGlobalMuteShortcut: (callback: () => void) => () => void
  onAlbumRankedBroadcast: (
    callback: (payload: {
      user: 'Vitinho' | 'Will'
      albumId: string
      albumName: string
      artistName: string
      rating: number
    }) => void
  ) => () => void
  onDjBotQueueAlbum: (
    callback: (payload: {
      albumName: string
      artistName: string
      tracks: Array<{ trackName: string }>
    }) => void
  ) => () => void
  onUpdaterStatus: (
    callback: (payload: {
      status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
      version?: string
      percent?: number
      message: string
    }) => void
  ) => () => void
  startLoopbackCapture: () => Promise<boolean>
  stopLoopbackCapture: () => Promise<boolean>
  onLoopbackAudioChunk: (callback: (chunk: Uint8Array) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    msnApi: MsnBridgeApi
  }
}
