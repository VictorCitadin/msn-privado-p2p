import type { SoundboardWinkId } from './soundManager'

export type MsnUser = 'Vitinho' | 'Will' | 'Nath'
export type PresenceStatus = 'online' | 'busy' | 'offline'

export const ALL_USERS: MsnUser[] = ['Vitinho', 'Will', 'Nath']

/**
 * Ordem de prioridade na negociação de cada par: quem vem antes na lista é quem cria as ofertas
 * oficiais (impolite peer). Vitinho↔Will continua exatamente como antes (Vitinho oferece).
 */
const NEGOTIATION_RANK: Record<MsnUser, number> = { Vitinho: 0, Will: 1, Nath: 2 }

export function isOffererFor(me: MsnUser, friend: MsnUser): boolean {
  return NEGOTIATION_RANK[me] < NEGOTIATION_RANK[friend]
}

/** O par Vitinho↔Will compartilha o histórico do chat; a Nath só vê mensagens enviadas com ela online. */
export function sharesChatHistory(a: MsnUser, b: MsnUser): boolean {
  return a !== 'Nath' && b !== 'Nath'
}

export interface ChatMessageItem {
  id: string
  sender: MsnUser
  text?: string
  imageDataUrl?: string
  fileAttachment?: {
    fileName: string
    fileSize: number
    mimeType: string
    blobUrl: string
  }
  isSystem?: boolean
  timestamp: string
}

export interface DjTrackItem {
  id: string
  videoId: string
  title: string
  author: string
  durationSeconds: number
  thumbnail: string
  addedBy: MsnUser
}

export interface DjSyncState {
  playlist: DjTrackItem[]
  currentIndex: number
  isPlaying: boolean
  currentTime: number
  updatedBy: MsnUser
  updatedAt: number
}

export interface RemoteStreamIds {
  micStreamId: string | null
  camStreamId: string | null
  screenStreamId: string | null
}

export type DataChannelPacket =
  | {
      type: 'chat-message'
      id: string
      sender: MsnUser
      text?: string
      imageDataUrl?: string
      timestamp: string
    }
  | {
      type: 'nudge'
      sender: MsnUser
      timestamp: string
    }
  | {
      type: 'soundboard-wink'
      sender: MsnUser
      winkId: SoundboardWinkId
      label: string
    }
  | {
      type: 'subnick-update'
      sender: MsnUser
      subnick: string
      status: PresenceStatus
    }
  | {
      type: 'dj-sync'
      state: DjSyncState
      // true quando é o envio do estado atual ao (re)abrir o DataChannel, não uma ação do usuário
      initial?: boolean
    }
  | {
      type: 'album-ranked'
      user: MsnUser
      albumId: string
      albumName: string
      artistName: string
      rating: number
    }
  | {
      type: 'heartbeat'
      sender: MsnUser
      seq: number
      timestamp: number
    }
  | {
      type: 'heartbeat-ack'
      sender: MsnUser
      seq: number
      timestamp: number
    }
  | {
      type: 'screen-share-state'
      sender: MsnUser
      active: boolean
      screenStreamId?: string | null
    }
  | ({
      type: 'stream-meta'
      sender: MsnUser
    } & RemoteStreamIds)
  | {
      type: 'room-state'
      sender: MsnUser
      inRoom: boolean
    }
  | {
      type: 'chat-history-sync'
      sender: MsnUser
      messages: ChatMessageItem[]
    }
  | {
      type: 'file-start'
      transferId: string
      sender: MsnUser
      fileName: string
      fileSize: number
      mimeType: string
      totalChunks: number
    }
  | {
      type: 'file-chunk'
      transferId: string
      chunkIndex: number
      dataBase64: string
    }
  | {
      type: 'file-end'
      transferId: string
      aborted?: boolean
    }

export type CallHealth = 'connecting' | 'healthy' | 'degraded' | 'recovering' | 'dead'

export interface RemotePeerStreams {
  voice: MediaStream | null
  cam: MediaStream | null
  screen: MediaStream | null
}

export interface WebRTCCallbacks {
  onFriendPresenceChange: (
    friend: MsnUser,
    status: PresenceStatus,
    subnick: string,
    justLoggedIn: boolean
  ) => void
  onChatMessage: (msg: ChatMessageItem) => void
  onChatHistorySync?: (sender: MsnUser, messages: ChatMessageItem[]) => void
  onDataChannelOpen?: (friend: MsnUser) => void
  onNudgeReceived: (sender: MsnUser) => void
  onSoundboardWink: (sender: MsnUser, winkId: SoundboardWinkId, label: string) => void
  onDjSync: (state: DjSyncState, initial: boolean) => void
  onAlbumRankedNotification: (payload: {
    user: MsnUser
    albumId: string
    albumName: string
    artistName: string
    rating: number
  }) => void
  onCallStateChange: (state: {
    inCall: boolean
    /** Amigos que estão na sala agora (com ou sem você) */
    friendsInRoom: MsnUser[]
    isScreenSharing: boolean
    /** Quem está compartilhando a tela para você (ou null) */
    remoteScreenSharer: MsnUser | null
    callHealth: CallHealth
  }) => void
  /** Você saiu da sala porque a conexão com todos caiu */
  onCallDropped?: (reason: string) => void
  /** Um amigo caiu da ligação, mas você continua na sala com os outros */
  onFriendDroppedFromCall?: (friend: MsnUser, reason: string) => void
  onStreamsUpdated: (streams: {
    localCam: MediaStream | null
    localScreen: MediaStream | null
    remotes: Partial<Record<MsnUser, RemotePeerStreams>>
  }) => void
  onVoiceActivityChange: (isAnyoneSpeaking: boolean) => void
  onFileProgress: (
    info: {
      fileName: string
      percent: number
      direction: 'sending' | 'receiving'
    } | null
  ) => void
}
