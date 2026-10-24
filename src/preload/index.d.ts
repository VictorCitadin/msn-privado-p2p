import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  DesktopSourceItem,
  AlbumTrackItem,
  AlbumSearchResult,
  AlbumRankingRecord
} from './index'

export interface MsnBridgeApi {
  getSession: () => Promise<{
    sessionUser: 'Vitinho' | 'Will' | null
    subnick: string
    ecoMode: boolean
  }>
  setSession: (payload: {
    sessionUser: 'Vitinho' | 'Will' | null
    subnick?: string
    ecoMode?: boolean
  }) => Promise<boolean>
  openAlbumRanker: () => Promise<boolean>
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    msnApi: MsnBridgeApi
  }
}
