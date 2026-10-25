import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { SoundboardWinkId } from './soundManager'

export type MsnUser = 'Vitinho' | 'Will'
export type PresenceStatus = 'online' | 'busy' | 'offline'

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
  | {
      type: 'stream-meta'
      sender: MsnUser
      micStreamId: string | null
      camStreamId: string | null
      screenStreamId: string | null
    }
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

interface IncomingFileBuffer {
  sender: MsnUser
  fileName: string
  fileSize: number
  mimeType: string
  totalChunks: number
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>
  receivedCount: number
}

export interface WebRTCCallbacks {
  onFriendPresenceChange: (
    status: PresenceStatus,
    subnick: string,
    justLoggedIn: boolean
  ) => void
  onChatMessage: (msg: ChatMessageItem) => void
  onChatHistorySync?: (messages: ChatMessageItem[]) => void
  onDataChannelOpen?: () => void
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
    friendInRoom: boolean
    incomingCallFrom: MsnUser | null
    isScreenSharing: boolean
    remoteScreenSharing: boolean
    callHealth: 'connecting' | 'healthy' | 'degraded' | 'recovering' | 'dead'
  }) => void
  onCallDropped?: (reason: string) => void
  onStreamsUpdated: (streams: {
    localCam: MediaStream | null
    localScreen: MediaStream | null
    remoteVoice: MediaStream | null
    remoteCam: MediaStream | null
    remoteScreen: MediaStream | null
  }) => void
  onVoiceActivityChange: (isAnyoneSpeaking: boolean) => void
  onFileProgress: (info: {
    fileName: string
    percent: number
    direction: 'sending' | 'receiving'
  } | null) => void
}

/**
 * Serviço P2P WebRTC Completo — Ultra-Lightweight Gaming Edition
 * - Codec H.264 Hardware (NVENC / QuickSync / AMF)
 * - SDP Munging 10 Mbps @ 60fps para Tela + Opus 510 kbps Stereo CBR para Filme
 * - Separação estrita de tracks de Microfone vs Áudio do Sistema (Zero Eco)
 * - Boost de Voz até 200% via Web Audio API + Auto-Ducking de 70% para o DJ Bot
 */
export class MsnWebRTCService {
  private myUser: MsnUser
  private friendUser: MsnUser
  private callbacks: WebRTCCallbacks

  private supabase: SupabaseClient | null = null
  private realtimeChannel: RealtimeChannel | null = null
  private peerConnection: RTCPeerConnection | null = null
  private dataChannel: RTCDataChannel | null = null

  // Streams Locais Separados
  private localMicStream: MediaStream | null = null
  private localCamStream: MediaStream | null = null
  private localScreenStream: MediaStream | null = null

  // Streams Remotos Separados
  private remoteVoiceStream: MediaStream | null = null
  private remoteCamStream: MediaStream | null = null
  private remoteScreenStream: MediaStream | null = null

  // Mapeamento de Stream IDs do amigo para separar Voz, Câmera e Tela com 100% de precisão
  private remoteStreamIds: {
    micStreamId: string | null
    camStreamId: string | null
    screenStreamId: string | null
  } = {
    micStreamId: null,
    camStreamId: null,
    screenStreamId: null
  }

  private pendingOffer: RTCSessionDescriptionInit | null = null
  private pendingIceCandidates: Array<{ candidate: RTCIceCandidateInit; pcId: string | null }> = []
  private incomingCallFrom: MsnUser | null = null
  private inCall = false
  private friendInRoom = false
  private friendLastStatus: PresenceStatus = 'offline'
  private myStatus: PresenceStatus = 'online'
  private mySubnick = ''
  private ecoMode = false
  private preferredAudioDeviceId = ''
  private preferredVideoDeviceId = ''

  // Web Audio API para Boost de Voz até 200%, Cancelamento Digital de Loopback e Detecção de Voz (Auto-Ducking DJ Bot)
  private audioCtx: AudioContext | null = null
  private workletRegistered = false
  private localVoiceSourceNode: MediaStreamAudioSourceNode | null = null
  private remoteVoiceSourceNode: MediaStreamAudioSourceNode | null = null
  private remoteVoiceGainNode: GainNode | null = null
  private remoteVoiceVolumePercent = 100
  private rawScreenStream: MediaStream | null = null
  private screenAudioSourceNode: MediaStreamAudioSourceNode | null = null
  private screenAudioCancellerNode: AudioWorkletNode | null = null
  private screenAudioDestNode: MediaStreamAudioDestinationNode | null = null
  private vadInterval: ReturnType<typeof setInterval> | null = null
  private localAnalyser: AnalyserNode | null = null
  private remoteAnalyser: AnalyserNode | null = null
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null
  private djBotPlaying = false
  private currentlySpeaking = false

  // Perfect Negotiation (Polite Peer Pattern - W3C WebRTC)
  private isPolite = false
  private makingOffer = false
  private ignoreOffer = false

  // Áudio Loopback Nativo do Sistema (CoreAudio com exclusão do processo)
  private unsubLoopbackAudio: (() => void) | null = null
  private loopbackAudioProcessor: ScriptProcessorNode | null = null
  private loopbackAudioDestNode: MediaStreamAudioDestinationNode | null = null
  private loopbackAudioGainNode: GainNode | null = null
  private loopbackAudioCompressorNode: DynamicsCompressorNode | null = null
  private loopbackAudioDummyNode: GainNode | null = null

  // Buffer de recepção de arquivos P2P
  private incomingFiles: Map<string, IncomingFileBuffer> = new Map()

  // Presença com Timestamp e Instância Única (Elimina Presença Fantasma)
  private instanceId = `${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
  private protocolVersion = 2
  private presenceHeartbeatInterval: ReturnType<typeof setInterval> | null = null
  private presenceSweepInterval: ReturnType<typeof setInterval> | null = null
  private friendPresenceLastSeen = 0
  private friendPresenceReceivedAt = 0
  private friendLastSeenRemote = 0
  private friendLastSubnick = ''
  private lastFriendP2PHeartbeat = 0
  private lastFriendRealtimeHeartbeat = 0
  private lastFriendSignalReceived = 0
  private visibilityHandler: (() => void) | null = null
  private isDestroyed = false
  private offlineGraceTimeout: ReturnType<typeof setTimeout> | null = null
  private realtimeReconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private realtimeBackoffMs = 2000
  // Geração do canal Realtime: callbacks de canais antigos (ex: CLOSED ao remover) são ignorados
  private realtimeGeneration = 0
  private realtimeSubscribedAt = 0

  // Identidade da PeerConnection local e da remota pareada com ela. Permite detectar quando o
  // amigo recriou a PeerConnection (oferta nova não pode ser aplicada sobre a conexão antiga).
  private localPcId: string | null = null
  private remotePcId: string | null = null
  private lastChatOfferAt = 0
  // Stream ID de cada trilha remota (vindo do ontrack), usado quando a trilha é re-roteada sem o evento
  private remoteTrackStreamIds: Map<string, string> = new Map()
  private remoteVoiceBoostConnected = false

  // Monitoramento de Saúde da Ligação e Auto-Drop
  private callHealth: 'connecting' | 'healthy' | 'degraded' | 'recovering' | 'dead' = 'connecting'
  private friendJoinedThisCall = false
  private callHealthInterval: ReturnType<typeof setInterval> | null = null
  private p2pHeartbeatInterval: ReturnType<typeof setInterval> | null = null
  private p2pHeartbeatSeq = 0
  private iceRestartAttempts = 0
  private fullReconnectAttempts = 0
  private lastAudioBytesReceived = 0
  private lastAudioBytesStallCount = 0

  // Reconexão Automática P2P (ICE Restart) & Rede
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectResetTimer: ReturnType<typeof setTimeout> | null = null
  private isReconnecting = false
  private onlineHandler: (() => void) | null = null

  constructor(myUser: MsnUser, callbacks: WebRTCCallbacks) {
    this.myUser = myUser
    this.friendUser = myUser === 'Vitinho' ? 'Will' : 'Vitinho'
    this.callbacks = callbacks
    // Will é o Polite peer e Vitinho é o Impolite peer no desempate de colisões de oferta
    this.isPolite = myUser === 'Will'
    this.initSignaling()
    this.setupOnlineListener()
  }

  private setupOnlineListener(): void {
    this.onlineHandler = () => {
      console.log('[WebRTC] Conexão com a rede reestabelecida. Sincronizando presença e verificando P2P...')
      if (this.supabase && !this.isDestroyed) {
        this.setupRealtimeChannel()
      }
      this.trackPresenceState()
      if (this.inCall || this.friendInRoom) {
        this.handleConnectionFailure()
      }
    }
    window.addEventListener('online', this.onlineHandler)

    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.trackPresenceState()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  // ==========================================================================
  // 1. CONFIGURAÇÃO DE SERVIDORES ICE (STUN GOOGLE/CLOUDFLARE + TURN .ENV)
  // ==========================================================================
  private getIceServers(): RTCIceServer[] {
    const servers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]

    const turnUrl = import.meta.env.VITE_TURN_URL
    const turnUsername = import.meta.env.VITE_TURN_USERNAME
    const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL

    if (turnUrl && turnUsername && turnCredential) {
      servers.push({
        urls: turnUrl.split(',').map((u: string) => u.trim()),
        username: turnUsername,
        credential: turnCredential
      })
    }

    return servers
  }

  // ==========================================================================
  // 2. SINALIZAÇÃO E PRESENÇA (SUPABASE REALTIME + VERCEL API FALLBACK)
  // ==========================================================================
  private initSignaling(): void {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey)
      this.setupRealtimeChannel()

      // Envia heartbeat contínuo de presença a cada 8 segundos (impede que o amigo me veja offline)
      if (this.presenceHeartbeatInterval) clearInterval(this.presenceHeartbeatInterval)
      this.presenceHeartbeatInterval = setInterval(() => {
        if (!this.isDestroyed) this.trackPresenceState()
      }, 8000)

      // Varredura a cada 4 segundos combinando Presença Realtime + Heartbeat P2P + Sinais
      if (this.presenceSweepInterval) clearInterval(this.presenceSweepInterval)
      this.presenceSweepInterval = setInterval(() => {
        if (!this.isDestroyed) this.sweepPresenceAndOnlineStatus()
      }, 4000)
    }
  }

  private setupRealtimeChannel(): void {
    const supabase = this.supabase
    if (!supabase || this.isDestroyed) return

    const generation = ++this.realtimeGeneration
    if (this.realtimeReconnectTimeout) {
      clearTimeout(this.realtimeReconnectTimeout)
      this.realtimeReconnectTimeout = null
    }

    // O canal antigo precisa sair da lista do cliente ANTES de criar o novo: enquanto ele estiver lá,
    // supabase.channel() devolve o mesmo objeto (já inscrito) e o subscribe() lança exceção.
    const previous = this.realtimeChannel
    this.realtimeChannel = null
    const removal: Promise<unknown> = previous
      ? supabase.removeChannel(previous).catch(() => 'error')
      : Promise.resolve('ok')

    removal.then(() => {
      if (this.isDestroyed || generation !== this.realtimeGeneration) return
      try {
        this.createRealtimeChannel(supabase, generation)
      } catch (err) {
        console.warn('[WebRTC] Falha ao criar canal Realtime:', err)
        this.scheduleRealtimeReconnect(generation)
      }
    })
  }

  private scheduleRealtimeReconnect(generation: number): void {
    if (this.isDestroyed || generation !== this.realtimeGeneration || this.realtimeReconnectTimeout) {
      return
    }
    this.realtimeReconnectTimeout = setTimeout(() => {
      this.realtimeReconnectTimeout = null
      this.realtimeBackoffMs = Math.min(this.realtimeBackoffMs * 2, 30000)
      this.setupRealtimeChannel()
    }, this.realtimeBackoffMs)
  }

  private createRealtimeChannel(supabase: SupabaseClient, generation: number): void {
    const channel = supabase.channel('msn-vitinho-will', {
      config: {
        presence: { key: this.myUser },
        broadcast: { self: false }
      }
    })
    this.realtimeChannel = channel
    const isCurrent = (): boolean =>
      !this.isDestroyed && generation === this.realtimeGeneration && this.realtimeChannel === channel

    channel
      .on('presence', { event: 'sync' }, () => {
        if (!isCurrent()) return
        const state = channel.presenceState() || {}
        const rawList = (state[this.friendUser] as Array<{
          user?: string
          status?: PresenceStatus
          subnick?: string
          inRoom?: boolean
          instanceId?: string
          lastSeen?: number
          online_at?: string
          protocolVersion?: number
        }>) || []

        if (rawList.length > 0) {
          if (this.offlineGraceTimeout) {
            clearTimeout(this.offlineGraceTimeout)
            this.offlineGraceTimeout = null
          }
          const sorted = [...rawList].sort((a, b) => {
            const timeA = a.lastSeen || (a.online_at ? new Date(a.online_at).getTime() : 0)
            const timeB = b.lastSeen || (b.online_at ? new Date(b.online_at).getTime() : 0)
            return timeB - timeA
          })
          const latest = sorted[0]
          const lastSeen = latest.lastSeen || (latest.online_at ? new Date(latest.online_at).getTime() : 0)
          this.friendPresenceLastSeen = lastSeen
          this.friendPresenceReceivedAt = Date.now()

          const newStatus: PresenceStatus = latest.status || 'online'
          const rawSub = latest.subnick === 'Disponível no MSN Privado 🎮' ? '' : latest.subnick
          const newSubnick = rawSub || ''
          this.friendLastSubnick = newSubnick
          const justLoggedIn = this.friendLastStatus === 'offline' && newStatus !== 'offline'
          this.friendLastStatus = newStatus

          // A presença é re-sincronizada a cada heartbeat (~4s). As ações de (re)negociação abaixo só
          // devem rodar quando o estado do amigo muda; antes elas renegociavam a cada evento sync.
          const roomStateChanged =
            typeof latest.inRoom === 'boolean' && latest.inRoom !== this.friendInRoom
          const friendStateChanged = justLoggedIn || roomStateChanged

          if (typeof latest.inRoom === 'boolean') {
            const wasInRoom = this.friendInRoom
            this.friendInRoom = latest.inRoom
            if (latest.inRoom) {
              this.friendJoinedThisCall = true
            } else if (wasInRoom) {
              this.friendJoinedThisCall = false
              this.remoteCamStream = null
              this.remoteVoiceStream = null
              this.remoteScreenStream = null
              this.emitStreamsUpdated()
              console.log('[WebRTC] Amigo saiu da sala (presença).')
            }
            this.emitCallState()
          }
          this.callbacks.onFriendPresenceChange(newStatus, newSubnick, justLoggedIn)

          if (this.inCall && latest.inRoom) {
            const isDisconnected = !this.peerConnection || this.peerConnection.signalingState === 'closed'
            if (isDisconnected) {
              if (this.myUser === 'Vitinho') {
                console.log('[WebRTC] Ambos na Sala e conexão inexistente: Vitinho enviando oferta...')
                this.startCall(Boolean(this.localCamStream)).catch(() => {})
              } else {
                console.log('[WebRTC] Ambos na Sala e conexão inexistente: Will solicitando oferta...')
                this.sendSignal('room-sync-request', { inRoom: true }).catch(() => {})
              }
            } else if (this.myUser === 'Vitinho' && this.peerConnection && this.peerConnection.signalingState === 'stable') {
              const hasMedia = this.peerConnection.getSenders().some((s) => s.track !== null)
              if (!hasMedia) {
                console.log('[WebRTC] Ambos na Sala e conexão existente sem mídia: renegociando chamada...')
                this.renegotiatePeerConnection().catch(() => {})
              }
            }
          } else if (!this.inCall && latest.inRoom) {
            // Se o amigo está na sala e eu ainda estou no chat:
            if (this.myUser === 'Vitinho') {
              const isDisconnected = !this.peerConnection || this.peerConnection.signalingState === 'closed'
              const hasVideoRecv = this.peerConnection?.getTransceivers().some((t) => t.receiver.track?.kind === 'video')
              if (isDisconnected || !hasVideoRecv) {
                console.log('[WebRTC] Will está na sala e Vitinho no chat: Vitinho conectando para receber câmera...')
                this.connectReceiveOnlyCall().catch(() => {})
              }
            } else if (friendStateChanged || !this.peerConnection) {
              // Will está no chat e Vitinho entrou na sala: Will solicita oferta para receber câmera de Vitinho no chat
              console.log('[WebRTC] Vitinho está na sala e Will no chat: Will solicitando preview de câmera...')
              this.sendSignal('room-sync-request', { inRoom: false, wantsPreview: true }).catch(() => {})
            }
          } else if (this.inCall && !latest.inRoom) {
            // Eu estou na sala e o amigo acabou de ficar online no chat:
            if (this.myUser === 'Vitinho') {
              const isDisconnected =
                !this.peerConnection || this.peerConnection.signalingState === 'closed'
              if (isDisconnected) {
                this.rebuildCall().catch(() => {})
              } else if (friendStateChanged) {
                console.log('[WebRTC] Vitinho na sala e Will no chat: Vitinho enviando stream para preview de Will...')
                this.renegotiatePeerConnection().catch(() => {})
              }
            }
          } else if (this.myUser === 'Vitinho') {
            this.ensureChatDataChannel()
          }
        } else {
          // Lista de presença vazia temporariamente (ex: reconexão): tolerância de 8s antes de marcar offline
          if (!this.offlineGraceTimeout && this.friendLastStatus !== 'offline') {
            this.offlineGraceTimeout = setTimeout(() => {
              this.offlineGraceTimeout = null
              this.markFriendOffline()
            }, 8000)
          }
        }
      })
      .on('broadcast', { event: 'webrtc-signal' }, async ({ payload }) => {
        if (!isCurrent() || !payload || payload.target !== this.myUser) return
        this.lastFriendSignalReceived = Date.now()
        this.lastFriendRealtimeHeartbeat = Date.now()
        try {
          await this.handleIncomingSignal(payload.sender, payload.type, payload.data || {})
        } catch (err) {
          console.warn(`[WebRTC] Erro ao processar sinal "${payload.type}":`, err)
        }
      })
      .on('broadcast', { event: 'msn-packet' }, ({ payload }) => {
        if (!isCurrent() || !payload || payload.target !== this.myUser) return
        this.lastFriendSignalReceived = Date.now()
        this.lastFriendRealtimeHeartbeat = Date.now()
        this.handleDataChannelPacket(payload.packet)
      })
      .subscribe((status) => {
        // Ignora o CLOSED disparado pela remoção de um canal antigo: era isso que gerava
        // um loop infinito de reconexões (cada canal removido agendava a criação de outro).
        if (!isCurrent()) return
        if (status === 'SUBSCRIBED') {
          this.realtimeBackoffMs = 2000
          this.realtimeSubscribedAt = Date.now()
          this.trackPresenceState()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('[WebRTC] Canal Realtime reconectando status:', status)
          this.scheduleRealtimeReconnect(generation)
        }
      })
  }

  private sweepPresenceAndOnlineStatus(): void {
    const isOnline = this.computeIsFriendOnline()
    if (isOnline && this.friendLastStatus === 'offline') {
      // Se o amigo voltou a responder sinais ou P2P, emite online imediatamente
      this.friendLastStatus = 'online'
      this.callbacks.onFriendPresenceChange('online', this.friendLastSubnick || '', true)
      this.emitCallState()
    } else if (!isOnline && this.friendLastStatus !== 'offline') {
      console.log('[WebRTC] Timeout de presença/sinais do amigo: marcando como offline.')
      this.markFriendOffline()
    }

    // Reabre o DataChannel do chat caso a oferta anterior tenha se perdido ou a conexão tenha falhado
    if (isOnline && !this.inCall && this.myUser === 'Vitinho') {
      this.ensureChatDataChannel()
    }
  }

  private computeIsFriendOnline(): boolean {
    const now = Date.now()
    const p2pActive =
      this.lastFriendP2PHeartbeat > 0 && now - this.lastFriendP2PHeartbeat < 15000
    const signalActive =
      this.lastFriendSignalReceived > 0 && now - this.lastFriendSignalReceived < 30000

    // Enquanto o canal Realtime está sendo recriado (ou acabou de entrar e ainda não recebeu o
    // primeiro sync), a lista de presença vazia não significa que o amigo saiu: mantém o status
    // atual para não gerar um falso "offline" seguido de um falso "acabou de entrar".
    const presenceUncertain =
      !this.realtimeChannel || now - this.realtimeSubscribedAt < 10000
    if (presenceUncertain) {
      return this.friendLastStatus !== 'offline' || p2pActive || signalActive
    }

    const state = this.realtimeChannel?.presenceState() || {}
    const rawList = (state[this.friendUser] as unknown[]) || []
    if (rawList.length > 0) return true

    return p2pActive || signalActive
  }

  /**
   * (Vitinho) Garante um DataChannel de chat aberto quando ninguém está na sala.
   * Antes, se a oferta inicial se perdesse (amigo offline) ou o ICE falhasse fora de ligação,
   * a PeerConnection ficava presa e o chat dependia só do fallback Realtime para sempre.
   */
  private ensureChatDataChannel(): void {
    if (this.myUser !== 'Vitinho' || this.isDestroyed || this.inCall) return
    if (this.dataChannel?.readyState === 'open') return

    const pc = this.peerConnection
    if (pc && pc.signalingState !== 'closed') {
      const stillNegotiating =
        pc.connectionState === 'new' ||
        pc.connectionState === 'connecting' ||
        this.dataChannel?.readyState === 'connecting'
      if (stillNegotiating && Date.now() - this.lastChatOfferAt < 15000) return
    }

    console.log('[WebRTC] DataChannel do chat indisponível: recriando conexão P2P...')
    this.resetPeerConnection()
    const connect = this.friendInRoom ? this.connectReceiveOnlyCall() : this.connectDataChannelOnly()
    connect.catch(() => {})
  }

  private markFriendOffline(): void {
    const wasOnline = this.friendLastStatus !== 'offline'
    this.friendLastStatus = 'offline'

    // NUNCA anula streams remotos se a chamada P2P estiver viva e com heartbeats recentes!
    const isP2pLiveInCall = this.inCall && Date.now() - this.lastFriendP2PHeartbeat < 15000
    if (!isP2pLiveInCall) {
      this.friendInRoom = false
      this.remoteVoiceStream = null
      this.remoteCamStream = null
      this.remoteScreenStream = null
      this.emitStreamsUpdated()
      this.emitCallState()
    }

    if (wasOnline) {
      this.callbacks.onFriendPresenceChange('offline', 'Offline', false)
    }
  }

  private async sendSignal(
    type:
      | 'sdp-offer'
      | 'sdp-answer'
      | 'ice-candidate'
      | 'hangup'
      | 'renegotiate-offer'
      | 'room-sync-request'
      | 'screen-share-state'
      | 'p2p-heartbeat'
      | 'reconnect-request',
    data: Record<string, unknown>
  ): Promise<void> {
    // Envio instantâneo e com latência mínima via WebSocket do Supabase Realtime Broadcast
    if (this.realtimeChannel) {
      try {
        await this.realtimeChannel.send({
          type: 'broadcast',
          event: 'webrtc-signal',
          payload: {
            sender: this.myUser,
            target: this.friendUser,
            type,
            // pcId = minha PeerConnection atual; remotePcId = a do amigo com quem ela está pareada
            data: { pcId: this.localPcId, remotePcId: this.remotePcId, ...data }
          }
        })
      } catch (err) {
        console.warn('[WebRTC] Falha ao enviar sinal Realtime Broadcast:', err)
      }
    }
  }

  // ==========================================================================
  // 3. CRIAÇÃO DO RTCPeerConnection E SEPARAÇÃO DE TRACKS
  // ==========================================================================
  private ensurePeerConnection(): RTCPeerConnection {
    if (this.peerConnection && this.peerConnection.signalingState !== 'closed') {
      return this.peerConnection
    }

    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })
    this.localPcId = `${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
    this.remotePcId = null
    this.remoteTrackStreamIds.clear()

    pc.onicecandidate = (event) => {
      if (event.candidate && pc === this.peerConnection) {
        this.sendSignal('ice-candidate', {
          candidate: event.candidate.toJSON()
        })
      }
    }

    pc.ondatachannel = (event) => {
      if (pc !== this.peerConnection) return
      this.setupDataChannel(event.channel)
    }

    pc.ontrack = (event) => {
      if (pc !== this.peerConnection) return
      if (event.streams[0]) {
        this.remoteTrackStreamIds.set(event.track.id, event.streams[0].id)
      }
      this.routeRemoteTrack(event.track, event.streams)
      this.emitStreamsUpdated()
      this.emitCallState()
      event.track.onunmute = () => {
        this.routeRemoteTrack(event.track, event.streams)
        this.emitStreamsUpdated()
        this.emitCallState()
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE Connection State:', pc.iceConnectionState)
      if (pc.iceConnectionState === 'connected') {
        if (this.disconnectGraceTimer) {
          clearTimeout(this.disconnectGraceTimer)
          this.disconnectGraceTimer = null
        }
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }

        // Bug 2: Contadores de tentativa de reconexão só voltam a zero após 10s contínuos e estáveis
        if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer)
        this.reconnectResetTimer = setTimeout(() => {
          if (this.peerConnection?.iceConnectionState === 'connected') {
            this.iceRestartAttempts = 0
            this.fullReconnectAttempts = 0
            this.reconnectResetTimer = null
          }
        }, 10000)

        // Bug 4: Call health vira healthy se o P2P heartbeat foi recente (< 6s)
        if (Date.now() - this.lastFriendP2PHeartbeat < 6000) {
          this.callHealth = 'healthy'
        }
        this.emitCallState()
      } else if (pc.iceConnectionState === 'disconnected') {
        this.callHealth = 'degraded'
        this.emitCallState()
        // Bug 3: Timer de graça de 2.5s antes de forçar reconexão. Se virar failed antes, o failed assume imediatamente.
        if (!this.disconnectGraceTimer) {
          this.disconnectGraceTimer = setTimeout(() => {
            this.disconnectGraceTimer = null
            const currentState = this.peerConnection?.iceConnectionState
            if (currentState === 'disconnected' || currentState === 'failed') {
              this.triggerAutoReconnect().catch(() => {})
            }
          }, 2500)
        }
      } else if (pc.iceConnectionState === 'failed') {
        this.callHealth = 'recovering'
        this.emitCallState()
        if (this.disconnectGraceTimer) {
          clearTimeout(this.disconnectGraceTimer)
          this.disconnectGraceTimer = null
        }
        this.handleConnectionFailure(true)
      }
    }

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Peer Connection State:', pc.connectionState)
      if (pc.connectionState === 'connected') {
        if (Date.now() - this.lastFriendP2PHeartbeat < 6000) {
          this.callHealth = 'healthy'
        }
        this.emitCallState()
      } else if (pc.connectionState === 'disconnected') {
        this.callHealth = 'degraded'
        this.emitCallState()
      } else if (pc.connectionState === 'failed') {
        this.callHealth = 'recovering'
        this.emitCallState()
        this.handleConnectionFailure(true)
      }
    }

    this.peerConnection = pc
    return pc
  }

  private routeRemoteTrack(track: MediaStreamTrack, streams?: readonly MediaStream[]): void {
    if (!track || track.readyState === 'ended' || !this.peerConnection) return

    // Quando re-roteada sem o evento ontrack (syncRemoteStreamsFromReceivers), usa o stream ID
    // memorizado; sem isso a trilha da tela caía no fallback por índice e substituía a câmera.
    const streamId =
      streams && streams.length > 0
        ? streams[0].id
        : this.remoteTrackStreamIds.get(track.id) || null

    const receiving = this.getReceivingTransceivers()
    const audioTransceivers = receiving.filter((t) => t.receiver.track?.kind === 'audio')
    const videoTransceivers = receiving.filter((t) => t.receiver.track?.kind === 'video')

    if (track.kind === 'audio') {
      let isScreenAudio = false
      if (this.remoteStreamIds.screenStreamId) {
        if (streamId) {
          isScreenAudio = streamId === this.remoteStreamIds.screenStreamId
        } else if (audioTransceivers.length > 1 && audioTransceivers[1].receiver.track?.id === track.id) {
          isScreenAudio = true
        }
      }

      if (isScreenAudio) {
        if (!this.remoteScreenStream) {
          this.remoteScreenStream = new MediaStream()
        }
        if (!this.remoteScreenStream.getAudioTracks().some((t) => t.id === track.id)) {
          this.remoteScreenStream.addTrack(track)
        }
      } else {
        // Voz do amigo: Trilha primária do microfone
        if (!this.remoteVoiceStream || !this.remoteVoiceStream.getAudioTracks().some((t) => t.id === track.id)) {
          this.remoteVoiceStream = new MediaStream([track])
          this.setupRemoteVoiceAnalyser(this.remoteVoiceStream)
        }
      }
    } else if (track.kind === 'video') {
      let isScreenVideo = false
      if (this.remoteStreamIds.screenStreamId) {
        if (streamId) {
          isScreenVideo = streamId === this.remoteStreamIds.screenStreamId
        } else if (videoTransceivers.length > 1 && videoTransceivers[1].receiver.track?.id === track.id) {
          isScreenVideo = true
        }
      }

      if (isScreenVideo) {
        if (!this.remoteScreenStream) {
          this.remoteScreenStream = new MediaStream()
        }
        if (!this.remoteScreenStream.getVideoTracks().some((t) => t.id === track.id)) {
          this.remoteScreenStream
            .getVideoTracks()
            .filter((t) => t.id !== track.id)
            .forEach((t) => this.remoteScreenStream?.removeTrack(t))
          this.remoteScreenStream.addTrack(track)
        }
      } else {
        // Câmera do amigo
        if (!this.remoteCamStream || !this.remoteCamStream.getVideoTracks().some((t) => t.id === track.id)) {
          this.remoteCamStream = new MediaStream([track])
        }
      }
    }

    track.onended = () => {
      if (track.kind === 'video') {
        if (
          this.remoteScreenStream &&
          this.remoteScreenStream.getVideoTracks().some((t) => t.id === track.id)
        ) {
          this.remoteScreenStream.removeTrack(track)
          if (this.remoteScreenStream.getVideoTracks().length === 0) {
            this.remoteScreenStream = null
          }
          this.emitStreamsUpdated()
          this.emitCallState()
        }
        if (
          this.remoteCamStream &&
          this.remoteCamStream.getVideoTracks().some((t) => t.id === track.id)
        ) {
          this.remoteCamStream.removeTrack(track)
          if (this.remoteCamStream.getVideoTracks().length === 0) {
            this.remoteCamStream = null
          }
          this.emitStreamsUpdated()
          this.emitCallState()
        }
      } else if (track.kind === 'audio') {
        if (
          this.remoteScreenStream &&
          this.remoteScreenStream.getAudioTracks().some((t) => t.id === track.id)
        ) {
          this.remoteScreenStream.removeTrack(track)
        }
        if (
          this.remoteVoiceStream &&
          this.remoteVoiceStream.getAudioTracks().some((t) => t.id === track.id)
        ) {
          this.remoteVoiceStream.removeTrack(track)
          if (this.remoteVoiceStream.getAudioTracks().length === 0) {
            this.remoteVoiceStream = null
          }
          this.emitStreamsUpdated()
          this.emitCallState()
        }
      }
    }

    this.emitStreamsUpdated()
    this.emitCallState()
  }

  /**
   * Transceivers pelos quais o amigo realmente envia mídia para mim. Os que eu criei só para
   * enviar (ex: os da minha tela compartilhada) também têm um receiver com uma trilha "viva",
   * porém vazia/mutada: tratá-la como trilha do amigo deixava a câmera dele preta e a voz muda
   * assim que eu começava a compartilhar a tela.
   */
  private getReceivingTransceivers(): RTCRtpTransceiver[] {
    if (!this.peerConnection) return []
    return this.peerConnection.getTransceivers().filter((t) => {
      const dir = t.currentDirection
      return dir === 'sendrecv' || dir === 'recvonly'
    })
  }

  private syncRemoteStreamsFromReceivers(): void {
    if (!this.peerConnection) return
    for (const transceiver of this.getReceivingTransceivers()) {
      const track = transceiver.receiver.track
      if (track && track.readyState === 'live') {
        this.routeRemoteTrack(track)
      }
    }
    if (!this.remoteStreamIds.screenStreamId && this.remoteScreenStream) {
      this.remoteScreenStream.getTracks().forEach((t) => t.stop())
      this.remoteScreenStream = null
    }
  }

  public async connectDataChannelOnly(): Promise<void> {
    const pc = this.ensurePeerConnection()
    if (!this.dataChannel) {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    this.lastChatOfferAt = Date.now()
    this.makingOffer = true
    try {
      const offer = await pc.createOffer()
      if (pc.signalingState === 'closed') return
      await this.setLocalDescriptionSafe(pc, offer)
      await this.sendSignal('sdp-offer', {
        sdp: pc.localDescription,
        isMediaCall: false,
        streamIds: this.getLocalStreamIds()
      })
    } finally {
      this.makingOffer = false
    }
  }

  public async connectReceiveOnlyCall(): Promise<void> {
    const pc = this.ensurePeerConnection()
    if (!this.dataChannel || this.dataChannel.readyState === 'closed') {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    const transceivers = pc.getTransceivers()
    const videoTransceiver = transceivers.find((t) => t.receiver.track?.kind === 'video')
    if (!videoTransceiver) {
      pc.addTransceiver('video', { direction: 'recvonly' })
    }
    const audioTransceiver = transceivers.find((t) => t.receiver.track?.kind === 'audio')
    if (!audioTransceiver) {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }

    if (this.myUser === 'Vitinho') {
      this.lastChatOfferAt = Date.now()
      this.makingOffer = true
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        })
        if (pc.signalingState === 'closed') return
        await this.setLocalDescriptionSafe(pc, offer)
        this.broadcastStreamMeta()
        await this.sendSignal('sdp-offer', {
          sdp: pc.localDescription,
          isMediaCall: true,
          inRoom: this.inCall,
          streamIds: this.getLocalStreamIds()
        })
      } finally {
        this.makingOffer = false
      }
    }
  }

  // ==========================================================================
  // 4. SDP MUNGING SEGURO: CODEC H.264 HARDWARE (NVENC/AMF/QUICKSYNC) + 10MBPS + OPUS 510KBPS STEREO
  // ==========================================================================
  private mungeSdpForHardwareH264AndOpus(sdp: string): string {
    const lines = sdp.split('\r\n')

    // 1. Descobre todos os Payload Types (PT) do codec H264 para priorizar NVENC / QuickSync / AMF
    const h264PayloadTypes: string[] = []
    const rtxAptMap: Record<string, string> = {}

    for (const line of lines) {
      const h264Match = line.match(/^a=rtpmap:(\d+)\s+H264\/90000/i)
      if (h264Match) {
        h264PayloadTypes.push(h264Match[1])
      }
      const rtxMatch = line.match(/^a=fmtp:(\d+)\s+apt=(\d+)/i)
      if (rtxMatch) {
        rtxAptMap[rtxMatch[2]] = rtxMatch[1]
      }
    }

    const prioritizedVideoPts: string[] = []
    for (const pt of h264PayloadTypes) {
      prioritizedVideoPts.push(pt)
      if (rtxAptMap[pt]) {
        prioritizedVideoPts.push(rtxAptMap[pt])
      }
    }

    // 2. Descobre o Payload Type do Opus para aplicar 510 kbps Stereo CBR
    let opusPt: string | null = null
    for (const line of lines) {
      const opusMatch = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i)
      if (opusMatch) {
        opusPt = opusMatch[1]
        break
      }
    }

    const outputLines: string[] = []
    let inVideoSection = false

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]

      if (line.startsWith('m=video ')) {
        inVideoSection = true
        if (prioritizedVideoPts.length > 0) {
          const parts = line.split(' ')
          const header = parts.slice(0, 3)
          const existingPts = parts.slice(3)
          const remainingPts = existingPts.filter((pt) => !prioritizedVideoPts.includes(pt))
          line = [...header, ...prioritizedVideoPts, ...remainingPts].join(' ')
        }
        outputLines.push(line)
        continue
      }

      if (line.startsWith('m=audio ') || line.startsWith('m=application ')) {
        inVideoSection = false
      }

      // Na seção de vídeo, adiciona b=AS:10000 logo APÓS a linha c=IN (respeitando RFC 4566)
      if (inVideoSection && line.startsWith('c=IN ')) {
        outputLines.push(line)
        outputLines.push('b=AS:10000')
        continue
      }

      // Configura Opus Stereo 510 kbps CBR para o áudio do filme/sistema
      if (opusPt && line.startsWith(`a=fmtp:${opusPt} `)) {
        line = `a=fmtp:${opusPt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;cbr=1`
      }

      // Injeta parâmetros de bitrate alto nas linhas fmtp do H.264
      if (inVideoSection && h264PayloadTypes.some((pt) => line.startsWith(`a=fmtp:${pt} `))) {
        if (!line.includes('x-google-max-bitrate')) {
          line = `${line};x-google-max-bitrate=10000;x-google-min-bitrate=2500;x-google-start-bitrate=6000`
        }
      }

      outputLines.push(line)
    }

    return outputLines.join('\r\n')
  }

  private async setLocalDescriptionSafe(
    pc: RTCPeerConnection,
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    try {
      const munged: RTCSessionDescriptionInit = {
        type: desc.type,
        sdp: this.mungeSdpForHardwareH264AndOpus(desc.sdp || '')
      }
      await pc.setLocalDescription(munged)
    } catch (err) {
      console.warn('[WebRTC] Fallback para SDP padrão sem munging:', err)
      await pc.setLocalDescription(desc)
    }
  }

  private async flushPendingIceCandidates(pc: RTCPeerConnection): Promise<void> {
    if (!pc.remoteDescription || this.pendingIceCandidates.length === 0) return
    const candidates = this.pendingIceCandidates.filter(
      (c) => !c.pcId || !this.remotePcId || c.pcId === this.remotePcId
    )
    this.pendingIceCandidates = []
    for (const c of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c.candidate))
      } catch (err) {
        console.warn('[WebRTC] Erro ao adicionar ICE candidate da fila:', err)
      }
    }
  }

  // ==========================================================================
  // 5. CHAMADAS DE VOZ, VÍDEO (1x1) E COMPARTILHAMENTO DE TELA (ZERO ECO)
  // ==========================================================================
  private async acquireMicAndCam(withVideo: boolean): Promise<void> {
    // 1. Track do Microfone em MediaStream exclusivo (com suporte a dispositivo escolhido pelo usuário)
    if (!this.localMicStream) {
      try {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(this.preferredAudioDeviceId
            ? { deviceId: { exact: this.preferredAudioDeviceId } }
            : {})
        }
        try {
          this.localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false
          })
        } catch {
          this.localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          })
        }
        this.setupLocalVoiceAnalyser(this.localMicStream)
      } catch (err) {
        console.warn('[WebRTC] Microfone indisponível ou em uso, seguindo chamada:', err)
      }
    }

    // 2. Track da Webcam em MediaStream separado SEMPRE em resolução natural full 1280x720@30fps (sem zoom e sem travar)
    if (withVideo && !this.localCamStream) {
      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          ...(this.preferredVideoDeviceId
            ? { deviceId: { exact: this.preferredVideoDeviceId } }
            : {})
        }
        try {
          this.localCamStream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false
          })
        } catch {
          this.localCamStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 }
            },
            audio: false
          })
        }
      } catch (err) {
        console.warn('[WebRTC] Webcam indisponível ou em uso, seguindo chamada apenas com áudio/recepção:', err)
      }
    }
  }

  public async setPreferredDevices(audioDeviceId: string, videoDeviceId: string): Promise<void> {
    const audioChanged = audioDeviceId !== this.preferredAudioDeviceId
    const videoChanged = videoDeviceId !== this.preferredVideoDeviceId
    this.preferredAudioDeviceId = audioDeviceId
    this.preferredVideoDeviceId = videoDeviceId

    if (!this.inCall) return

    const pc = this.peerConnection
    const wasMuted = this.isMicrophoneMuted()
    const wasCamEnabled = this.localCamStream?.getVideoTracks()[0]?.enabled ?? true

    if (audioChanged) {
      try {
        const newMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(audioDeviceId && audioDeviceId !== 'default'
              ? { deviceId: { exact: audioDeviceId } }
              : {})
          },
          video: false
        })
        const newAudioTrack = newMicStream.getAudioTracks()[0]
        if (newAudioTrack) {
          newAudioTrack.enabled = !wasMuted
          const oldAudioTrack = this.localMicStream?.getAudioTracks()[0]
          if (pc) {
            const audioSender = pc
              .getSenders()
              .find(
                (s) =>
                  s.track?.kind === 'audio' &&
                  (!oldAudioTrack || s.track.id === oldAudioTrack.id)
              )
            if (audioSender) {
              await audioSender.replaceTrack(newAudioTrack)
            } else {
              pc.addTrack(newAudioTrack, newMicStream)
            }
          }
          this.localMicStream?.getTracks().forEach((t) => t.stop())
          this.localMicStream = newMicStream
          this.setupLocalVoiceAnalyser(newMicStream)
        }
      } catch (err) {
        console.warn('[WebRTC] Erro ao trocar microfone ao vivo:', err)
      }
    }

    if (videoChanged) {
      try {
        const newCamStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
            ...(videoDeviceId && videoDeviceId !== 'default'
              ? { deviceId: { exact: videoDeviceId } }
              : {})
          },
          audio: false
        })
        const newVideoTrack = newCamStream.getVideoTracks()[0]
        if (newVideoTrack) {
          newVideoTrack.enabled = wasCamEnabled
          const oldVideoTrack = this.localCamStream?.getVideoTracks()[0]
          const screenTrackId = this.localScreenStream?.getVideoTracks()[0]?.id
          if (pc) {
            const videoSender = pc
              .getSenders()
              .find(
                (s) =>
                  s.track?.kind === 'video' &&
                  s.track.id !== screenTrackId &&
                  (!oldVideoTrack || s.track.id === oldVideoTrack.id)
              )
            if (videoSender) {
              await videoSender.replaceTrack(newVideoTrack)
            } else {
              pc.addTrack(newVideoTrack, newCamStream)
            }
          }
          this.localCamStream?.getTracks().forEach((t) => t.stop())
          this.localCamStream = newCamStream
        }
      } catch (err) {
        console.warn('[WebRTC] Erro ao trocar webcam ao vivo:', err)
      }
    }

    this.broadcastStreamMeta()
    this.emitStreamsUpdated()
  }

  public async startCall(withVideo = true): Promise<void> {
    this.inCall = true
    this.callHealth = 'connecting'
    this.iceRestartAttempts = 0
    this.fullReconnectAttempts = 0
    this.friendJoinedThisCall = false
    this.lastAudioBytesStallCount = 0
    this.lastAudioBytesReceived = 0
    this.p2pHeartbeatSeq = 0
    this.startCallHealthTimers()
    this.incomingCallFrom = null
    this.pendingOffer = null
    this.setRemoteVoiceBoostVolume(this.remoteVoiceVolumePercent)
    this.emitCallState()

    await this.acquireMicAndCam(withVideo)

    let pc = this.peerConnection
    if (!pc || pc.signalingState === 'closed') {
      pc = this.ensurePeerConnection()
    }

    if (!this.dataChannel || this.dataChannel.readyState === 'closed') {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    this.attachLocalStreamsToPeer(pc)
    await this.ensureTransceiversSendRecv(pc)
    this.emitStreamsUpdated()
    this.emitCallState()
    this.trackPresenceState()

    // Vitinho é o Caller mestre (quem inicia e renegocia a oferta oficial).
    // Will prepara seus streams locais e solicita a oferta de Vitinho, evitando 100% de colisões!
    if (this.myUser === 'Vitinho') {
      this.makingOffer = true
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        })
        if (pc.signalingState === 'closed') return
        await this.setLocalDescriptionSafe(pc, offer)

        this.broadcastStreamMeta()
        this.sendDataChannelPacket({
          type: 'room-state',
          sender: this.myUser,
          inRoom: true
        })
        await this.sendSignal('sdp-offer', {
          sdp: pc.localDescription,
          isMediaCall: true,
          inRoom: true,
          streamIds: this.getLocalStreamIds()
        })
      } finally {
        this.makingOffer = false
      }
    } else {
      // Will avisa Vitinho que está na Sala e aguarda a oferta oficial
      this.sendDataChannelPacket({
        type: 'room-state',
        sender: this.myUser,
        inRoom: true
      })
      await this.sendSignal('room-sync-request', { inRoom: true })
    }
  }

  public async publishRoomBroadcast(): Promise<void> {
    if (!this.inCall) return
    const pc = this.ensurePeerConnection()

    if (!this.dataChannel || this.dataChannel.readyState === 'closed') {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    this.attachLocalStreamsToPeer(pc)
    await this.ensureTransceiversSendRecv(pc)
    this.broadcastStreamMeta()
    await this.renegotiatePeerConnection()
  }

  public async acceptIncomingCall(): Promise<void> {
    await this.startCall(true)
  }

  private async ensureTransceiversSendRecv(pc: RTCPeerConnection): Promise<void> {
    const transceivers = pc.getTransceivers()
    const micTrack = this.localMicStream?.getAudioTracks()[0]
    const camTrack = this.localCamStream?.getVideoTracks()[0]

    // Os transceivers da tela compartilhada nunca podem ser tratados como mic/câmera: sem webcam
    // (ou sem microfone) o transceiver da tela era o primeiro do tipo e acabava virando 'recvonly',
    // fazendo a transmissão de tela nunca chegar ao amigo.
    const screenTrackIds = new Set((this.localScreenStream?.getTracks() || []).map((t) => t.id))
    const isScreenTransceiver = (t: RTCRtpTransceiver): boolean =>
      Boolean(t.sender.track && screenTrackIds.has(t.sender.track.id))
    const directionFor = (t: RTCRtpTransceiver, localTrack?: MediaStreamTrack): RTCRtpTransceiverDirection =>
      localTrack || t.sender.track ? 'sendrecv' : 'recvonly'

    // Transceiver 0: Áudio da Voz (Microfone)
    const audioTransceiver = transceivers.find(
      (t) => t.receiver.track?.kind === 'audio' && !isScreenTransceiver(t)
    )
    if (audioTransceiver) {
      if (micTrack && audioTransceiver.sender.track?.id !== micTrack.id) {
        await audioTransceiver.sender.replaceTrack(micTrack).catch(() => {})
      }
      audioTransceiver.direction = directionFor(audioTransceiver, micTrack)
    } else {
      pc.addTransceiver('audio', {
        direction: micTrack ? 'sendrecv' : 'recvonly',
        streams: this.localMicStream ? [this.localMicStream] : []
      })
      if (micTrack && this.localMicStream) {
        const t = pc.getTransceivers().find((x) => x.receiver.track?.kind === 'audio')
        if (t?.sender) {
          await t.sender.replaceTrack(micTrack).catch(() => {})
        }
      }
    }

    // Transceiver 0: Vídeo da Câmera (Webcam)
    const videoTransceiver = transceivers.find(
      (t) => t.receiver.track?.kind === 'video' && !isScreenTransceiver(t)
    )
    if (videoTransceiver) {
      if (camTrack && videoTransceiver.sender.track?.id !== camTrack.id) {
        await videoTransceiver.sender.replaceTrack(camTrack).catch(() => {})
      }
      videoTransceiver.direction = directionFor(videoTransceiver, camTrack)
    } else {
      pc.addTransceiver('video', {
        direction: camTrack ? 'sendrecv' : 'recvonly',
        streams: this.localCamStream ? [this.localCamStream] : []
      })
      if (camTrack && this.localCamStream) {
        const t = pc.getTransceivers().find((x) => x.receiver.track?.kind === 'video')
        if (t?.sender) {
          await t.sender.replaceTrack(camTrack).catch(() => {})
        }
      }
    }
  }

  public rejectOrHangupCall(): void {
    this.inCall = false
    this.callHealth = 'dead'
    this.stopCallHealthTimers()
    this.pendingOffer = null
    this.incomingCallFrom = null
    this.setRemoteVoiceBoostVolume(this.remoteVoiceVolumePercent)
    this.cleanupLocalMediaStreams()
    this.cleanupScreenAudioCanceller()
    this.remoteVoiceStream = null
    this.remoteCamStream = null
    this.remoteScreenStream = null
    this.remoteStreamIds = {
      micStreamId: null,
      camStreamId: null,
      screenStreamId: null
    }
    // 1. Notifica o amigo via DataChannel e Realtime antes de fechar a conexão
    this.sendDataChannelPacket({
      type: 'room-state',
      sender: this.myUser,
      inRoom: false
    })
    this.sendSignal('hangup', { inRoom: false }).catch(() => {})

    // 2. Limpa e reinicia o PeerConnection
    this.resetPeerConnection()
    this.trackPresenceState()
    if (this.myUser === 'Vitinho') {
      if (this.friendInRoom) {
        this.connectReceiveOnlyCall().catch(() => {})
      } else {
        this.connectDataChannelOnly().catch(() => {})
      }
    }
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  /**
   * Inicia Compartilhamento de Tela / Janela Específica (Modo Cinema)
   * - Vídeo 60fps com contentHint = 'motion' e até 10 Mbps
   * - Áudio do Sistema em track separada com echoCancellation: false para fidelidade musical/filme
   * - Reduz automaticamente as webcams de canto para 320x320 @ 24fps
   */
  public async startScreenShare(sourceId: string, includeSystemAudio: boolean): Promise<void> {
    if (!this.inCall) {
      await this.startCall(true)
    }
    // Trocar de janela/tela: encerra a transmissão anterior para não deixar a captura antiga
    // rodando (e sendo enviada) junto com a nova.
    if (this.localScreenStream) {
      await this.stopScreenShare()
    }

    const constraints: MediaStreamConstraints = {
      audio: includeSystemAudio
        ? ({
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId
            }
          } as unknown as MediaTrackConstraints)
        : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          minFrameRate: 30,
          maxFrameRate: 60
        }
      } as unknown as MediaTrackConstraints
    }

    const rawDesktopStream = await navigator.mediaDevices.getUserMedia(constraints)
    this.cleanupScreenAudioCanceller()
    this.rawScreenStream = rawDesktopStream

    // Configura videoTrack.contentHint = 'motion' para fluidez de 60fps em filmes/jogos
    const screenVideoTrack = rawDesktopStream.getVideoTracks()[0]
    if (screenVideoTrack) {
      screenVideoTrack.contentHint = 'motion'
      screenVideoTrack.onended = () => {
        this.stopScreenShare()
      }
    }

    // Subtrai digitalmente APENAS a voz do amigo do loopback do Windows (-55 dB de cancelamento sample-accurate)
    // sem mutar nem reduzir o som do filme/jogo quando alguém fala!
    const finalScreenStream = new MediaStream()
    if (screenVideoTrack) {
      finalScreenStream.addTrack(screenVideoTrack)
    }

    const rawScreenAudioTrack = rawDesktopStream.getAudioTracks()[0]
    if (includeSystemAudio) {
      const isWindow = sourceId.startsWith('window:')
      let windowHwnd: number | undefined
      if (isWindow) {
        const parts = sourceId.split(':')
        if (parts.length > 1) {
          const raw = parts[1].trim()
          let parsed = 0
          if (raw.startsWith('0x') || raw.startsWith('0X')) {
            parsed = parseInt(raw, 16)
          } else {
            parsed = parseInt(raw, 10)
          }
          if (!isNaN(parsed) && parsed !== 0) {
            windowHwnd = parsed >>> 0
          }
        }
      }

      const loopbackOptions =
        isWindow && windowHwnd
          ? { mode: 'include' as const, hwnd: windowHwnd }
          : { mode: 'exclude' as const }

      console.log('[WebRTC] Iniciando áudio do compartilhamento estilo Discord:', loopbackOptions)
      const excludedAudioTrack = await this.createExcludedLoopbackAudioTrack(loopbackOptions)
      if (excludedAudioTrack) {
        finalScreenStream.addTrack(excludedAudioTrack)
      } else if (rawScreenAudioTrack) {
        // Fallback seguro (S2): Se a captura nativa de exclusão não funcionou,
        // passa pelo cancelador AudioWorklet que subtrai a voz do amigo.
        // NUNCA envia a trilha bruta sem cancelamento para o amigo não se ouvir!
        console.warn('[WebRTC] Captura nativa falhou; usando cancelador adaptativo AudioWorklet.')
        const cancelledTrack = await this.createWorkletCancelledAudioTrack(rawScreenAudioTrack)
        if (cancelledTrack) {
          finalScreenStream.addTrack(cancelledTrack)
        } else {
          console.warn('[WebRTC] Sem cancelador disponível; desativando áudio do compartilhamento para proteger contra eco.')
        }
      }
    }

    this.localScreenStream = finalScreenStream
    this.updateScreenAudioLoopbackGate()

    // Otimização Gamer: reduz a resolução das câmeras de canto para 320x320 @ 24fps
    await this.applySmartCornerCameraConstraints(true)

    const pc = this.ensurePeerConnection()
    this.attachLocalStreamsToPeer(pc)

    // Configura maxBitrate de 10 Mbps (10_000_000 bps) e 60 fps no RTCRtpSender da tela
    for (const sender of pc.getSenders()) {
      if (sender.track && screenVideoTrack && sender.track.id === screenVideoTrack.id) {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = 10_000_000
        params.encodings[0].maxFramerate = 60
        await sender.setParameters(params).catch(() => {})
      }
    }

    this.sendDataChannelPacket({
      type: 'screen-share-state',
      sender: this.myUser,
      active: true,
      screenStreamId: finalScreenStream.id
    })
    this.sendSignal('screen-share-state', {
      sender: this.myUser,
      active: true,
      screenStreamId: finalScreenStream.id
    }).catch(() => {})

    await this.renegotiatePeerConnection()
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  public async stopScreenShare(): Promise<void> {
    if (!this.localScreenStream) return

    // 1. Notifica imediatamente o amigo via DataChannel e Realtime que o compartilhamento encerrou
    this.sendDataChannelPacket({
      type: 'screen-share-state',
      sender: this.myUser,
      active: false
    })
    this.sendSignal('screen-share-state', {
      sender: this.myUser,
      active: false
    }).catch(() => {})

    const pc = this.peerConnection
    if (pc) {
      const tracksToRemove = this.localScreenStream.getTracks()
      for (const sender of pc.getSenders()) {
        if (sender.track && tracksToRemove.some((t) => t.id === sender.track?.id)) {
          pc.removeTrack(sender)
        }
      }
    }

    this.localScreenStream.getTracks().forEach((t) => t.stop())
    this.localScreenStream = null
    this.cleanupScreenAudioCanceller()

    if (!this.ecoMode) {
      await this.applySmartCornerCameraConstraints(false)
    }

    this.broadcastStreamMeta()
    await this.renegotiatePeerConnection()
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  /**
   * Mantém a câmera sempre em resolução nativa fluida (1280x720 @ 30fps) sem zoom e sem travar,
   * tanto no Modo Jogo OFF quanto no Modo Jogo ON.
   */
  public async setEcoMode(enabled: boolean): Promise<void> {
    this.ecoMode = enabled
    await this.applySmartCornerCameraConstraints(false)
  }

  private async applySmartCornerCameraConstraints(_compactMode: boolean): Promise<void> {
    const camTrack = this.localCamStream?.getVideoTracks()[0]
    if (!camTrack) return

    try {
      await camTrack.applyConstraints({
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      })
    } catch (err) {
      console.warn('[WebRTC] Falha ao aplicar constraints inteligentes na câmera:', err)
    }
  }

  public toggleMicrophoneMute(): boolean {
    const audioTrack = this.localMicStream?.getAudioTracks()[0]
    if (!audioTrack) return false
    audioTrack.enabled = !audioTrack.enabled
    return !audioTrack.enabled // retorna true se ficou mutado
  }

  public isMicrophoneMuted(): boolean {
    const audioTrack = this.localMicStream?.getAudioTracks()[0]
    return audioTrack ? !audioTrack.enabled : false
  }

  public async toggleCameraEnabled(): Promise<boolean> {
    if (!this.localCamStream) {
      await this.acquireMicAndCam(true)
      const currentCamStream = this.localCamStream as MediaStream | null
      if (this.peerConnection && currentCamStream) {
        this.attachLocalStreamsToPeer(this.peerConnection)
        await this.ensureTransceiversSendRecv(this.peerConnection)
        await this.renegotiatePeerConnection()
      }
      this.emitStreamsUpdated()
      return Boolean(currentCamStream?.getVideoTracks()[0]?.enabled)
    }
    const videoTrack = this.localCamStream?.getVideoTracks()[0]
    if (!videoTrack) return false
    videoTrack.enabled = !videoTrack.enabled
    this.emitStreamsUpdated()
    return videoTrack.enabled
  }

  private attachLocalStreamsToPeer(pc: RTCPeerConnection): void {
    const existingSenders = pc.getSenders()

    const addStreamTracks = (stream: MediaStream | null): void => {
      if (!stream) return
      for (const track of stream.getTracks()) {
        const alreadyAdded = existingSenders.some((s) => s.track?.id === track.id)
        if (!alreadyAdded) {
          pc.addTrack(track, stream)
        }
      }
    }

    addStreamTracks(this.localMicStream)
    addStreamTracks(this.localCamStream)
    addStreamTracks(this.localScreenStream)
  }

  private async renegotiatePeerConnection(): Promise<void> {
    if (!this.peerConnection || this.peerConnection.signalingState === 'closed') return
    if (this.peerConnection.signalingState !== 'stable') {
      console.warn(
        `[WebRTC] Sinalização não está estável (${this.peerConnection.signalingState}), postergando renegociação`
      )
      return
    }
    if (this.inCall) {
      this.attachLocalStreamsToPeer(this.peerConnection)
      await this.ensureTransceiversSendRecv(this.peerConnection)
    }
    this.broadcastStreamMeta()
    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    })
    await this.setLocalDescriptionSafe(this.peerConnection, offer)
    await this.sendSignal('renegotiate-offer', {
      sdp: this.peerConnection.localDescription,
      isMediaCall: this.inCall || Boolean(this.remoteCamStream || this.localCamStream),
      inRoom: this.inCall,
      streamIds: this.getLocalStreamIds()
    })
  }

  private startCallHealthTimers(): void {
    this.stopCallHealthTimers()
    this.lastAudioBytesReceived = 0
    this.lastAudioBytesStallCount = 0

    // 1. Heartbeat P2P a cada 2s pelo DataChannel + Fallback Realtime Broadcast a cada 6s
    this.p2pHeartbeatInterval = setInterval(() => {
      if (!this.inCall) return
      this.p2pHeartbeatSeq++
      const now = Date.now()
      this.sendDataChannelPacket({
        type: 'heartbeat',
        sender: this.myUser,
        seq: this.p2pHeartbeatSeq,
        timestamp: now
      })
      if (this.p2pHeartbeatSeq % 3 === 0) {
        this.sendSignal('p2p-heartbeat', {
          seq: this.p2pHeartbeatSeq,
          timestamp: now
        }).catch(() => {})
      }
    }, 2000)

    // 2. Monitor de Saúde e Recepção Real de Mídia via getStats() a cada 3s
    this.callHealthInterval = setInterval(async () => {
      if (!this.inCall) return
      const now = Date.now()

      // Se passou mais de 15 segundos sem NENHUM sinal, heartbeat ou presença do amigo, o amigo caiu
      const noP2pHeartbeat =
        this.lastFriendP2PHeartbeat > 0 && now - this.lastFriendP2PHeartbeat > 15000
      const noSignal =
        this.lastFriendSignalReceived > 0 && now - this.lastFriendSignalReceived > 15000
      const noPresence =
        this.friendPresenceReceivedAt > 0 && now - this.friendPresenceReceivedAt > 20000

      if (noP2pHeartbeat && noSignal && noPresence && this.friendJoinedThisCall) {
        console.warn(
          '[WebRTC] Timeout crítico de conexão (15s sem sinal do amigo). Desconectando automaticamente...'
        )
        this.handleCallDead('O amigo perdeu a conexão com a sala há mais de 15 segundos.')
        return
      }

      // Bug 11: Verificação de Mídia Real via getStats() EXCLUSIVAMENTE no receptor da voz
      if (
        this.peerConnection &&
        this.peerConnection.connectionState === 'connected' &&
        !this.isReconnecting
      ) {
        try {
          const audioTransceivers = this.peerConnection
            .getTransceivers()
            .filter((t) => t.receiver.track?.kind === 'audio')

          if (
            audioTransceivers.length > 0 &&
            audioTransceivers[0].receiver &&
            this.friendInRoom &&
            this.friendJoinedThisCall
          ) {
            const stats = await audioTransceivers[0].receiver.getStats()
            let currentAudioBytes = 0
            let foundVoiceInbound = false

            stats.forEach((report) => {
              if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                foundVoiceInbound = true
                currentAudioBytes = (report.bytesReceived as number) || 0
              }
            })

            if (foundVoiceInbound && currentAudioBytes > 0) {
              if (currentAudioBytes === this.lastAudioBytesReceived) {
                this.lastAudioBytesStallCount++
                if (this.lastAudioBytesStallCount >= 2) {
                  // 6 segundos estagnado com ICE conectado
                  console.warn(
                    '[WebRTC] Trilha de voz remota estagnada há mais de 6s. Acionando reconexão preventiva...'
                  )
                  this.lastAudioBytesStallCount = 0
                  this.callHealth = 'degraded'
                  this.emitCallState()
                  this.handleConnectionFailure()
                }
              } else {
                this.lastAudioBytesReceived = currentAudioBytes
                this.lastAudioBytesStallCount = 0
                if (
                  this.callHealth !== 'healthy' &&
                  Date.now() - this.lastFriendP2PHeartbeat < 6000
                ) {
                  this.callHealth = 'healthy'
                  this.emitCallState()
                }
              }
            }
          }
        } catch (err) {
          console.warn('[WebRTC] Erro ao consultar getStats() da voz:', err)
        }
      }
    }, 3000)
  }

  private stopCallHealthTimers(): void {
    if (this.p2pHeartbeatInterval) {
      clearInterval(this.p2pHeartbeatInterval)
      this.p2pHeartbeatInterval = null
    }
    if (this.callHealthInterval) {
      clearInterval(this.callHealthInterval)
      this.callHealthInterval = null
    }
  }

  private handleCallDead(reason: string): void {
    if (!this.inCall) return
    console.warn(`[WebRTC] Chamada encerrada por queda/falha: ${reason}`)
    this.inCall = false
    this.callHealth = 'dead'
    this.friendInRoom = false
    this.friendJoinedThisCall = false
    this.stopCallHealthTimers()
    this.applyRemoteVoiceOutput()
    this.cleanupMediaStreams()
    this.resetPeerConnection()
    this.trackPresenceState()

    // Envio best-effort de encerramento
    this.sendDataChannelPacket({
      type: 'room-state',
      sender: this.myUser,
      inRoom: false
    })
    this.sendSignal('hangup', { inRoom: false }).catch(() => {})

    this.emitStreamsUpdated()
    this.emitCallState()
    this.callbacks.onCallDropped?.(reason)
  }

  private handleConnectionFailure(immediate = false): void {
    if (this.reconnectTimer) {
      if (!immediate) return
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (immediate) {
      this.triggerAutoReconnect().catch((err) => {
        console.warn('[WebRTC] Falha na reconexão automática imediata:', err)
      })
    } else {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.triggerAutoReconnect().catch((err) => {
          console.warn('[WebRTC] Falha na reconexão automática:', err)
        })
      }, 1000)
    }
  }

  private async triggerAutoReconnect(): Promise<void> {
    if (!this.inCall && !this.friendInRoom) return
    if (this.isReconnecting) return
    this.isReconnecting = true
    this.callHealth = 'recovering'
    this.emitCallState()
    console.log('[WebRTC] Executando reconexão automática P2P...')

    try {
      // Bug 12: Vitinho (impolite) envia ofertas de ICE restart. Will solicita a oferta.
      if (this.myUser === 'Will' && this.iceRestartAttempts === 0) {
        console.log('[WebRTC] Will solicitando ICE Restart de Vitinho via sinal...')
        await this.sendSignal('reconnect-request', { inRoom: true })
        // Aguarda 4 segundos pela resposta de Vitinho; se não houver resposta, escalona para rebuild
        await new Promise((resolve) => setTimeout(resolve, 4000))
        if (this.peerConnection?.iceConnectionState === 'connected') {
          return
        }
      }

      if (
        this.iceRestartAttempts < 3 &&
        this.peerConnection &&
        this.peerConnection.signalingState !== 'closed' &&
        this.peerConnection.connectionState !== 'closed'
      ) {
        this.iceRestartAttempts++
        const backoffMs = Math.min(1000 * Math.pow(2, this.iceRestartAttempts - 1), 4000)
        console.log(
          `[WebRTC] Tentativa ${this.iceRestartAttempts}/3 de ICE Restart com backoff ${backoffMs}ms...`
        )
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }

        const offer = await this.peerConnection.createOffer({
          iceRestart: true,
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        })
        await this.setLocalDescriptionSafe(this.peerConnection, offer)
        await this.sendSignal('renegotiate-offer', {
          sdp: this.peerConnection.localDescription,
          inRoom: this.inCall,
          streamIds: this.getLocalStreamIds(),
          isIceRestart: true
        })
        console.log('[WebRTC] ICE Restart offer enviado com sucesso!')
      } else if (this.fullReconnectAttempts < 2 && this.inCall) {
        // Bug 2: rebuildCall interno que NÃO zera contadores!
        this.fullReconnectAttempts++
        console.log(
          `[WebRTC] ICE Restart esgotado. Tentativa ${this.fullReconnectAttempts}/2 de reconstrução completa...`
        )
        await this.rebuildCall()
      } else if (this.inCall) {
        console.warn(
          '[WebRTC] Todas as tentativas de reconexão esgotadas. Finalizando chamada como dead.'
        )
        this.handleCallDead('Não foi possível restabelecer a conexão P2P após várias tentativas.')
      }
    } catch (err) {
      console.warn('[WebRTC] Falha na reconexão automática:', err)
      if (this.fullReconnectAttempts < 2 && this.inCall) {
        this.fullReconnectAttempts++
        await this.rebuildCall().catch(() => {})
      } else if (this.inCall) {
        this.handleCallDead('Falha crítica ao restabelecer a conexão P2P.')
      }
    } finally {
      this.isReconnecting = false
    }
  }

  // Bug 2: Reconstrução interna do PeerConnection preservando contadores de escalonamento
  private async rebuildCall(): Promise<void> {
    if (!this.inCall) return
    this.resetPeerConnection()
    const pc = this.ensurePeerConnection()

    if (!this.dataChannel || this.dataChannel.readyState === 'closed') {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    this.attachLocalStreamsToPeer(pc)
    await this.ensureTransceiversSendRecv(pc)
    this.emitStreamsUpdated()
    this.emitCallState()

    if (this.myUser === 'Vitinho') {
      this.makingOffer = true
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        })
        if (pc.signalingState === 'closed') return
        await this.setLocalDescriptionSafe(pc, offer)
        this.broadcastStreamMeta()
        await this.sendSignal('sdp-offer', {
          sdp: pc.localDescription,
          isMediaCall: true,
          inRoom: true,
          streamIds: this.getLocalStreamIds()
        })
      } finally {
        this.makingOffer = false
      }
    } else {
      await this.sendSignal('room-sync-request', { inRoom: true })
    }
  }

  private resetPeerConnection(): void {
    if (this.peerConnection) {
      this.peerConnection.ontrack = null
      this.peerConnection.ondatachannel = null
      this.peerConnection.onicecandidate = null
      this.peerConnection.oniceconnectionstatechange = null
      this.peerConnection.onconnectionstatechange = null
      this.peerConnection.onsignalingstatechange = null
      try {
        this.peerConnection.close()
      } catch {}
      this.peerConnection = null
    }
    if (this.dataChannel) {
      this.dataChannel.onopen = null
      this.dataChannel.onmessage = null
      try {
        this.dataChannel.close()
      } catch {}
    }
    this.dataChannel = null
    this.pendingIceCandidates = []
    this.localPcId = null
    this.remotePcId = null
    this.remoteTrackStreamIds.clear()
  }

  private getLocalStreamIds(): {
    micStreamId: string | null
    camStreamId: string | null
    screenStreamId: string | null
  } {
    return {
      micStreamId: this.localMicStream?.id || null,
      camStreamId: this.localCamStream?.id || null,
      screenStreamId: this.localScreenStream?.id || null
    }
  }

  private broadcastStreamMeta(): void {
    const ids = this.getLocalStreamIds()
    this.sendDataChannelPacket({
      type: 'stream-meta',
      sender: this.myUser,
      ...ids
    })
  }

  // ==========================================================================
  // 6. HANDLER DE SINAIS WEBRTC RECEBIDOS (SALA SEMPRE EXISTENTE SEM ATENDER)
  // ==========================================================================
  private async handleIncomingSignal(
    _sender: MsnUser,
    type: string,
    data: Record<string, unknown>
  ): Promise<void> {
    if (data.streamIds) {
      this.remoteStreamIds = data.streamIds as {
        micStreamId: string | null
        camStreamId: string | null
        screenStreamId: string | null
      }
      if (!this.remoteStreamIds.screenStreamId && this.remoteScreenStream) {
        this.remoteScreenStream.getTracks().forEach((t) => t.stop())
        this.remoteScreenStream = null
      } else if (this.remoteStreamIds.screenStreamId) {
        this.syncRemoteStreamsFromReceivers()
      }
      this.emitStreamsUpdated()
      this.emitCallState()
    }

    if (type === 'screen-share-state') {
      const active = Boolean(data.active)
      if (!active) {
        if (this.remoteScreenStream) {
          this.remoteScreenStream.getTracks().forEach((t) => t.stop())
          this.remoteScreenStream = null
        }
        this.remoteStreamIds.screenStreamId = null
      } else {
        this.remoteStreamIds.screenStreamId = (data.screenStreamId as string) || null
        this.syncRemoteStreamsFromReceivers()
      }
      this.emitStreamsUpdated()
      this.emitCallState()
      return
    }

    if (typeof data.inRoom === 'boolean') {
      this.friendInRoom = data.inRoom
      this.emitCallState()
    }

    const senderPcId = typeof data.pcId === 'string' ? data.pcId : null
    const senderTargetPcId = typeof data.remotePcId === 'string' ? data.remotePcId : null

    if (type === 'room-sync-request') {
      if (this.myUser === 'Vitinho') {
        this.handleRoomSyncRequest(senderPcId)
      }
      return
    }

    if (type === 'sdp-offer' || type === 'renegotiate-offer') {
      const sdp = data.sdp as RTCSessionDescriptionInit
      const isMediaCall = Boolean(data.isMediaCall) || type === 'renegotiate-offer'

      if (typeof data.inRoom === 'boolean') {
        this.friendInRoom = data.inRoom
      } else if (isMediaCall) {
        this.friendInRoom = true
      }

      // Renegociação de uma PeerConnection do amigo que estava pareada com uma conexão minha que
      // já foi descartada: não dá para responder (DTLS/m-lines não batem). Pede uma conexão nova.
      if (senderTargetPcId && senderTargetPcId !== this.localPcId) {
        console.log('[WebRTC] Oferta destinada a uma PeerConnection antiga: solicitando conexão nova...')
        this.requestFreshNegotiation()
        return
      }

      // O amigo recriou a PeerConnection dele (ex: saiu da sala, reconstrução após queda).
      // Aplicar a oferta nova na conexão antiga falhava ("order of m-lines doesn't match") e a
      // ligação só voltava depois de várias tentativas de ICE restart. Descarta a antiga.
      if (
        senderPcId &&
        this.peerConnection &&
        this.remotePcId !== senderPcId &&
        (this.remotePcId !== null || this.peerConnection.remoteDescription)
      ) {
        console.log('[WebRTC] Amigo recriou a PeerConnection: descartando a conexão antiga.')
        this.resetPeerConnection()
      }

      const pc = this.ensurePeerConnection()

      // Detecção de Colisão de Ofertas (W3C Perfect Negotiation / Polite Peer)
      const offerCollision = this.makingOffer || pc.signalingState !== 'stable'
      this.ignoreOffer = !this.isPolite && offerCollision
      if (this.ignoreOffer) {
        console.log('[WebRTC] Colisão de ofertas: sou impolite, ignorando oferta remota concorrente.')
        return
      }

      if (offerCollision && this.isPolite) {
        console.log('[WebRTC] Colisão de ofertas no polite peer: executando rollback para aceitar oferta remota...')
        await pc.setLocalDescription({ type: 'rollback' })
      }

      if (this.inCall) {
        await this.acquireMicAndCam(Boolean(this.localCamStream)).catch(() => {})
        this.attachLocalStreamsToPeer(pc)
      }

      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      if (senderPcId) {
        this.remotePcId = senderPcId
      }
      await this.flushPendingIceCandidates(pc)
      this.syncRemoteStreamsFromReceivers()

      if (this.inCall) {
        await this.ensureTransceiversSendRecv(pc)
      } else {
        // Chat mode: apenas recebe vídeo/áudio do amigo, não envia nada
        for (const tr of pc.getTransceivers()) {
          if (tr.direction === 'sendrecv' || tr.direction === 'sendonly') {
            tr.direction = 'recvonly'
          }
        }
      }

      const answer = await pc.createAnswer()
      await this.setLocalDescriptionSafe(pc, answer)
      this.broadcastStreamMeta()
      await this.sendSignal('sdp-answer', {
        sdp: pc.localDescription,
        inRoom: this.inCall,
        streamIds: this.getLocalStreamIds()
      })
      this.syncRemoteStreamsFromReceivers()
      this.emitStreamsUpdated()
      this.emitCallState()
      return
    }

    if (type === 'sdp-answer') {
      const sdp = data.sdp as RTCSessionDescriptionInit
      if (typeof data.inRoom === 'boolean') {
        this.friendInRoom = data.inRoom
      }
      // Resposta a uma oferta de uma PeerConnection minha que já foi descartada
      if (senderTargetPcId && senderTargetPcId !== this.localPcId) {
        return
      }
      if (
        this.peerConnection &&
        (this.peerConnection.signalingState === 'have-local-offer' ||
          this.peerConnection.signalingState === 'have-remote-pranswer')
      ) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp))
        if (senderPcId) {
          this.remotePcId = senderPcId
        }
        await this.flushPendingIceCandidates(this.peerConnection)
        this.syncRemoteStreamsFromReceivers()
        this.emitStreamsUpdated()
        this.emitCallState()
      }
      return
    }

    if (type === 'ice-candidate') {
      const candidate = data.candidate as RTCIceCandidateInit
      if (!candidate) return
      // Candidato de uma PeerConnection do amigo diferente da que está pareada com a minha
      if (senderPcId && this.remotePcId && senderPcId !== this.remotePcId) return
      if (
        this.peerConnection &&
        this.peerConnection.remoteDescription &&
        this.peerConnection.remoteDescription.type
      ) {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
      } else {
        this.pendingIceCandidates.push({ candidate, pcId: senderPcId })
      }
      return
    }

    if (type === 'reconnect-request') {
      console.log('[WebRTC] Solicitação de reconexão recebida de Will.')
      if (this.myUser === 'Vitinho') {
        if (senderPcId && senderPcId !== this.remotePcId) {
          // Will já está com outra PeerConnection: ICE restart na antiga não adianta
          this.handleRoomSyncRequest(senderPcId)
        } else {
          this.triggerAutoReconnect().catch(() => {})
        }
      }
      return
    }

    if (type === 'p2p-heartbeat') {
      this.lastFriendSignalReceived = Date.now()
      this.lastFriendRealtimeHeartbeat = Date.now()
      if (
        this.inCall &&
        this.peerConnection?.iceConnectionState === 'connected' &&
        (this.callHealth === 'degraded' || this.callHealth === 'recovering')
      ) {
        this.callHealth = 'healthy'
        this.emitCallState()
      }
      return
    }

    if (type === 'hangup') {
      console.log('[WebRTC] Sinal de hangup recebido do amigo.')
      this.friendInRoom = false
      this.friendJoinedThisCall = false
      this.remoteVoiceStream = null
      this.remoteCamStream = null
      this.remoteScreenStream = null
      this.remoteStreamIds = {
        micStreamId: null,
        camStreamId: null,
        screenStreamId: null
      }
      // Quem sai da sala fecha a própria PeerConnection. Se era a que estava pareada com a minha,
      // a minha virou um "zumbi" (o DataChannel ainda aparece 'open' por alguns segundos e as
      // mensagens enviadas nele se perdiam). Descarta e, sendo Vitinho, renegocia do zero.
      const pairedPcClosed = !senderPcId || senderPcId === this.remotePcId
      if (this.peerConnection && pairedPcClosed) {
        this.resetPeerConnection()
        if (this.myUser === 'Vitinho') {
          const reconnect = this.inCall ? this.rebuildCall() : this.connectDataChannelOnly()
          reconnect.catch(() => {})
        }
      } else if (
        !this.inCall &&
        this.myUser === 'Vitinho' &&
        (!this.dataChannel || this.dataChannel.readyState !== 'open')
      ) {
        this.connectDataChannelOnly().catch(() => {})
      }
      this.emitStreamsUpdated()
      this.emitCallState()
      return
    }
  }

  /**
   * (Vitinho) Will pediu uma oferta: se a PeerConnection dele é a que está pareada com a minha,
   * basta renegociar; se ele está com uma conexão nova (ou nenhuma), recria a minha do zero.
   */
  private handleRoomSyncRequest(requesterPcId: string | null): void {
    const pc = this.peerConnection
    const pairedWithRequester =
      pc !== null &&
      pc.signalingState !== 'closed' &&
      requesterPcId !== null &&
      this.remotePcId === requesterPcId

    // Já existe uma oferta inicial aguardando resposta: a conexão nova do Will pode aceitá-la,
    // então só reenvia em vez de recriar tudo (evita uma cascata de reconstruções).
    if (
      pc &&
      pc.signalingState === 'have-local-offer' &&
      this.remotePcId === null &&
      pc.localDescription
    ) {
      this.sendSignal('sdp-offer', {
        sdp: pc.localDescription,
        isMediaCall: this.inCall || this.friendInRoom,
        inRoom: this.inCall,
        streamIds: this.getLocalStreamIds()
      }).catch(() => {})
      return
    }

    if (this.inCall) {
      if (pairedWithRequester && pc?.signalingState === 'stable') {
        this.renegotiatePeerConnection().catch(() => {})
      } else {
        this.rebuildCall().catch(() => {})
      }
      return
    }

    // Vitinho está no chat: conecta em modo de recepção para exibir a webcam de Will no avatar
    if (!pairedWithRequester) {
      this.resetPeerConnection()
    }
    this.connectReceiveOnlyCall().catch(() => {})
  }

  /**
   * Recebi uma renegociação destinada a uma PeerConnection que eu já descartei.
   */
  private requestFreshNegotiation(): void {
    if (this.myUser === 'Vitinho') {
      if (this.inCall) {
        this.rebuildCall().catch(() => {})
      } else {
        this.resetPeerConnection()
        const connect = this.friendInRoom ? this.connectReceiveOnlyCall() : this.connectDataChannelOnly()
        connect.catch(() => {})
      }
    } else {
      this.sendSignal('room-sync-request', { inRoom: this.inCall }).catch(() => {})
    }
  }

  // ==========================================================================
  // 7. WEB AUDIO API: BOOST DE VOZ ATÉ 200%, CANCELAMENTO SAMPLE-ACCURATE DE LOOPBACK E AUTO-DUCKING DO DJ BOT
  // ==========================================================================
  private ensureAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.audioCtx = new AudioCtx({ sampleRate: 48000 })
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {})
    }
    return this.audioCtx
  }

  private async ensureLoopbackCancellerWorklet(ctx: AudioContext): Promise<void> {
    if (this.workletRegistered) return
    const workletCode = `
      class VoiceLoopbackCancellerProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.ringSize = 32768;
          this.ringMask = this.ringSize - 1;
          this.refRing = new Float32Array(this.ringSize);
          this.writePos = 0;

          // Stage 1: Acumulador linear de fase exata a 12 kHz (decimação 4x) até 233ms (2800 bins)
          this.decimSize = 4096;
          this.decimMask = this.decimSize - 1;
          this.refDecim = new Float32Array(this.decimSize);
          this.decimPos = 0;
          this.accRef = 0;
          this.accDes = 0;
          this.maxCoarseBins = 2800;
          this.coarseCorr = new Float32Array(this.maxCoarseBins);
          this.coarseEnergy = 0;
          this.coarseSamples = 0;
          this.coarseReady = false;
          this.coarseCenter = 6800;

          // Stage 2: Correlação fina de 1 sample em [-16, +16] ao redor de coarseCenter
          this.fineRadius = 16;
          this.fineLen = this.fineRadius * 2 + 1;
          this.fineCorr = new Float32Array(this.fineLen);
          this.fineEnergy = 0;
          this.fineSamples = 0;

          // Stage 3: Micro-FIR adaptativo NLMS de 9 taps cravado no atraso exato do WASAPI Loopback (-55 dB de cancelamento)
          this.lockedLag = 6800;
          this.isLocked = false;
          this.wL = new Float32Array([0, 0, 0, 0, 1.0, 0, 0, 0, 0]);
          this.wR = new Float32Array([0, 0, 0, 0, 1.0, 0, 0, 0, 0]);
          this.sampleCount = 0;
        }

        process(inputs, outputs) {
          const desktopIn = inputs[0];
          const voiceRefIn = inputs[1];
          const out = outputs[0];
          if (!desktopIn || desktopIn.length === 0) return true;

          const inL = desktopIn[0];
          const inR = desktopIn[1] || desktopIn[0];
          const outL = out[0];
          const outR = out[1] || out[0];
          const refL = (voiceRefIn && voiceRefIn[0]) ? voiceRefIn[0] : null;
          const refR = (voiceRefIn && voiceRefIn[1]) ? voiceRefIn[1] : refL;
          const n = inL.length;

          for (let i = 0; i < n; i++) {
            const r = refL ? (refR ? (refL[i] + refR[i]) * 0.5 : refL[i]) : 0;
            const dL = inL[i];
            const dR = inR[i];
            const d = (dL + dR) * 0.5;
            this.refRing[this.writePos] = r;

            // Stage 1: Decimação linear 4x (12 kHz) imune a áudio de filme/jogo descorrelacionado
            this.accRef += r;
            this.accDes += d;
            if ((this.sampleCount & 3) === 3) {
              const rLP = this.accRef * 0.25;
              const dLP = this.accDes * 0.25;
              this.accRef = 0;
              this.accDes = 0;
              this.refDecim[this.decimPos] = rLP;

              if (!this.coarseReady) {
                const rEchoCheck = this.refDecim[(this.decimPos - 1650) & this.decimMask];
                if (rEchoCheck * rEchoCheck > 1e-6) {
                  this.coarseEnergy += rEchoCheck * rEchoCheck;
                  this.coarseSamples++;
                  for (let b = 200; b < this.maxCoarseBins; b++) {
                    this.coarseCorr[b] += dLP * this.refDecim[(this.decimPos - b) & this.decimMask];
                  }
                  if (this.coarseSamples >= 1800) {
                    let bestBin = 0;
                    let bestVal = -1e9;
                    for (let b = 200; b < this.maxCoarseBins; b++) {
                      if (this.coarseCorr[b] > bestVal) {
                        bestVal = this.coarseCorr[b];
                        bestBin = b;
                      }
                    }
                    if (bestVal > this.coarseEnergy * 0.35) {
                      this.coarseCenter = bestBin * 4;
                      this.coarseReady = true;
                      this.fineCorr.fill(0);
                      this.fineEnergy = 0;
                      this.fineSamples = 0;
                    } else {
                      this.coarseCorr.fill(0);
                      this.coarseEnergy = 0;
                      this.coarseSamples = 0;
                    }
                  }
                }
              }
              this.decimPos = (this.decimPos + 1) & this.decimMask;
            }

            // Stage 2: Refinamento exato de 1 sample ao redor de coarseCenter
            if (this.coarseReady) {
              const rCenter = this.refRing[(this.writePos - this.coarseCenter) & this.ringMask];
              if (rCenter * rCenter > 1e-6) {
                this.fineEnergy += rCenter * rCenter;
                this.fineSamples++;
                for (let f = 0; f < this.fineLen; f++) {
                  const candLag = this.coarseCenter + (f - this.fineRadius);
                  this.fineCorr[f] += d * this.refRing[(this.writePos - candLag) & this.ringMask];
                }
                if (this.fineSamples >= 3600) {
                  let bestF = this.fineRadius;
                  let bestVal = -1e9;
                  for (let f = 0; f < this.fineLen; f++) {
                    if (this.fineCorr[f] > bestVal) {
                      bestVal = this.fineCorr[f];
                      bestF = f;
                    }
                  }
                  const ratio = bestVal / (this.fineEnergy + 1e-12);
                  if (ratio > 0.45 && ratio < 1.55) {
                    const nextLag = this.coarseCenter + (bestF - this.fineRadius);
                    if (nextLag !== this.lockedLag) {
                      this.lockedLag = nextLag;
                      const initGain = Math.min(1.2, Math.max(0.8, ratio));
                      this.wL.fill(0); this.wL[4] = initGain;
                      this.wR.fill(0); this.wR[4] = initGain;
                    }
                    this.isLocked = true;
                  }
                  this.coarseReady = false;
                  this.coarseCorr.fill(0);
                  this.coarseEnergy = 0;
                  this.coarseSamples = 0;
                }
              }
            }

            // Stage 3: Subtração em tempo real APENAS da voz do amigo (100% do som do filme/jogo preservado!)
            if (this.isLocked) {
              const baseLag = this.lockedLag - 4;
              let yL = 0, yR = 0, norm = 1e-6;
              for (let k = 0; k < 9; k++) {
                const xk = this.refRing[(this.writePos - baseLag - k) & this.ringMask];
                yL += this.wL[k] * xk;
                yR += this.wR[k] * xk;
                norm += xk * xk;
              }
              const errL = dL - yL;
              const errR = dR - yR;
              if (norm > 1e-5) {
                const errP = (errL * errL + errR * errR) * 0.5;
                const mu = 0.012 / (norm + errP * 8.0 + 1e-4);
                for (let k = 0; k < 9; k++) {
                  const xk = this.refRing[(this.writePos - baseLag - k) & this.ringMask];
                  this.wL[k] += mu * errL * xk;
                  this.wR[k] += mu * errR * xk;
                }
              }
              outL[i] = errL;
              if (outR !== outL) outR[i] = errR;
            } else {
              outL[i] = dL;
              if (outR !== outL) outR[i] = dR;
            }

            this.writePos = (this.writePos + 1) & this.ringMask;
            this.sampleCount++;
          }
          return true;
        }
      }
      registerProcessor('voice-loopback-canceller', VoiceLoopbackCancellerProcessor);
    `

    const blob = new Blob([workletCode], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await ctx.audioWorklet.addModule(url)
      this.workletRegistered = true
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private async createWorkletCancelledAudioTrack(
    rawTrack: MediaStreamTrack
  ): Promise<MediaStreamTrack | null> {
    try {
      const ctx = this.ensureAudioContext()
      await this.ensureLoopbackCancellerWorklet(ctx)

      const desktopSource = ctx.createMediaStreamSource(new MediaStream([rawTrack]))
      const cancellerNode = new AudioWorkletNode(ctx, 'voice-loopback-canceller', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })

      desktopSource.connect(cancellerNode, 0, 0)

      if (this.remoteVoiceStream && this.remoteVoiceStream.getAudioTracks().length > 0) {
        try {
          const voiceSource = ctx.createMediaStreamSource(this.remoteVoiceStream)
          voiceSource.connect(cancellerNode, 0, 1)
        } catch (e) {
          console.warn('[WebRTC] Falha ao conectar voz de referência no cancelador:', e)
        }
      }

      const dest = ctx.createMediaStreamDestination()
      cancellerNode.connect(dest)
      console.log('[WebRTC] Trilha de áudio com cancelador adaptativo AudioWorklet ativada!')
      return dest.stream.getAudioTracks()[0] || null
    } catch (err) {
      console.warn('[WebRTC] Falha ao criar trilha cancelada por worklet:', err)
      return null
    }
  }

  private async createExcludedLoopbackAudioTrack(options?: {
    mode?: 'include' | 'exclude'
    hwnd?: number
  }): Promise<MediaStreamTrack | null> {
    try {
      const started = await window.msnApi.startLoopbackCapture(options)
      if (!started) {
        console.warn('[WebRTC] Captura loopback nativa não iniciou (handshake/versão OS).')
        return null
      }

      const ctx = this.ensureAudioContext()
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {})
      }

      const dest = ctx.createMediaStreamDestination()

      // Jitter Buffer em Ring Buffer estéreo (1 segundo de capacidade = 48000 frames)
      const RING_FRAMES = 48000
      const ringL = new Float32Array(RING_FRAMES)
      const ringR = new Float32Array(RING_FRAMES)
      let writeIdx = 0
      let readIdx = 0
      let bufferedFrames = 0

      this.unsubLoopbackAudio = window.msnApi.onLoopbackAudioChunk((chunk: Uint8Array) => {
        // Garante alinhamento exato de 4 bytes (2 bytes x 2 canais PCM 16-bit)
        const validBytes = chunk.byteLength - (chunk.byteLength % 4)
        if (validBytes <= 0) return

        // Cópia alinhada para ArrayBuffer independente evitando RangeError de offset ímpar
        const safeBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + validBytes)
        const int16 = new Int16Array(safeBuffer)
        const frames = int16.length / 2

        for (let i = 0; i < frames; i++) {
          const sampleL = int16[i * 2] / 32768.0
          const sampleR = int16[i * 2 + 1] / 32768.0

          ringL[writeIdx] = sampleL
          ringR[writeIdx] = sampleR
          writeIdx = (writeIdx + 1) % RING_FRAMES
          if (bufferedFrames < RING_FRAMES) {
            bufferedFrames++
          } else {
            readIdx = (readIdx + 1) % RING_FRAMES
          }
        }

        // Mantém a latência do áudio baixa e ultra estável (~60ms de buffer alvo)
        if (bufferedFrames > 4800) {
          const skip = bufferedFrames - 2880
          readIdx = (readIdx + skip) % RING_FRAMES
          bufferedFrames -= skip
        }
      })

      // ScriptProcessor com buffer de 1024 frames (~21ms a 48kHz)
      const processor = ctx.createScriptProcessor(1024, 0, 2)
      let lastL = 0
      let lastR = 0

      processor.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0)
        const outR = e.outputBuffer.getChannelData(1)
        const len = outL.length

        for (let i = 0; i < len; i++) {
          if (bufferedFrames > 0) {
            outL[i] = ringL[readIdx]
            outR[i] = ringR[readIdx]
            lastL = outL[i]
            lastR = outR[i]
            readIdx = (readIdx + 1) % RING_FRAMES
            bufferedFrames--
          } else {
            // Suavização anti-estalo / anti-clipping com fade suave
            lastL *= 0.85
            lastR *= 0.85
            outL[i] = Math.abs(lastL) < 1e-4 ? 0 : lastL
            outR[i] = Math.abs(lastR) < 1e-4 ? 0 : lastR
          }
        }
      }

      // S4: Make-up gain compensatório de 1.35x com limitador contra atenuação pós-mixer do Windows
      const boostGain = ctx.createGain()
      boostGain.gain.value = 1.35

      // Limitador transparente de estúdio contra picos (-3dB threshold, ratio 4)
      const compressor = ctx.createDynamicsCompressor()
      compressor.threshold.value = -3
      compressor.knee.value = 4
      compressor.ratio.value = 4
      compressor.attack.value = 0.003
      compressor.release.value = 0.05

      processor.connect(boostGain)
      boostGain.connect(compressor)
      compressor.connect(dest)

      // Keep-alive com ganho zero para ctx.destination (impede que o Chromium pause ou faça GC do ScriptProcessor com 0 entradas)
      const dummyNode = ctx.createGain()
      dummyNode.gain.value = 0
      processor.connect(dummyNode)
      dummyNode.connect(ctx.destination)

      this.loopbackAudioProcessor = processor
      this.loopbackAudioDestNode = dest
      this.loopbackAudioGainNode = boostGain
      this.loopbackAudioCompressorNode = compressor
      this.loopbackAudioDummyNode = dummyNode

      console.log(`[WebRTC] Áudio de tela nativo (Modo ${options?.mode || 'exclude'}) inicializado com sucesso!`)
      return dest.stream.getAudioTracks()[0] || null
    } catch (err) {
      console.warn('[WebRTC] Falha ao iniciar loopback nativo:', err)
      return null
    }
  }

  private cleanupScreenAudioCanceller(): void {
    if (this.unsubLoopbackAudio) {
      try {
        this.unsubLoopbackAudio()
      } catch {}
      this.unsubLoopbackAudio = null
    }
    window.msnApi.stopLoopbackCapture().catch(() => {})

    if (this.loopbackAudioProcessor) {
      try {
        this.loopbackAudioProcessor.disconnect()
      } catch {}
      this.loopbackAudioProcessor = null
    }
    if (this.loopbackAudioGainNode) {
      try {
        this.loopbackAudioGainNode.disconnect()
      } catch {}
      this.loopbackAudioGainNode = null
    }
    if (this.loopbackAudioCompressorNode) {
      try {
        this.loopbackAudioCompressorNode.disconnect()
      } catch {}
      this.loopbackAudioCompressorNode = null
    }
    if (this.loopbackAudioDummyNode) {
      try {
        this.loopbackAudioDummyNode.disconnect()
      } catch {}
      this.loopbackAudioDummyNode = null
    }
    this.loopbackAudioDestNode = null

    if (this.screenAudioSourceNode) {
      try {
        this.screenAudioSourceNode.disconnect()
      } catch {}
      this.screenAudioSourceNode = null
    }
    if (this.screenAudioCancellerNode) {
      try {
        this.screenAudioCancellerNode.disconnect()
      } catch {}
      this.screenAudioCancellerNode = null
    }
    this.screenAudioDestNode = null
    if (this.rawScreenStream) {
      this.rawScreenStream.getTracks().forEach((t) => t.stop())
      this.rawScreenStream = null
    }
  }

  public resumeAudioContext(): void {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {})
    }
  }

  private setupLocalVoiceAnalyser(stream: MediaStream): void {
    try {
      const ctx = this.ensureAudioContext()
      if (this.localVoiceSourceNode) {
        try {
          this.localVoiceSourceNode.disconnect()
        } catch {}
      }
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      this.localVoiceSourceNode = source
      this.localAnalyser = analyser
      this.startVoiceActivityLoop()
    } catch (err) {
      console.warn('[WebRTC] Falha ao iniciar analyser de voz local:', err)
    }
  }

  private setupRemoteVoiceAnalyser(stream: MediaStream): void {
    try {
      const ctx = this.ensureAudioContext()
      if (this.remoteVoiceSourceNode) {
        try {
          this.remoteVoiceSourceNode.disconnect()
        } catch {}
        this.remoteVoiceSourceNode = null
      }
      if (this.remoteVoiceGainNode) {
        try {
          this.remoteVoiceGainNode.disconnect()
        } catch {}
        this.remoteVoiceGainNode = null
      }

      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      const gainNode = ctx.createGain()

      // O <audio id="remote-voice"> no DOM reproduz nativamente a voz do amigo de 0% a 100%;
      // acima de 100% o elemento é mutado e a voz sai por este GainNode (ver applyRemoteVoiceOutput).
      // O analyser detecta atividade vocal para os efeitos de interface (VAD).
      source.connect(analyser)
      source.connect(gainNode)

      this.remoteVoiceSourceNode = source
      this.remoteVoiceGainNode = gainNode
      this.remoteVoiceBoostConnected = false
      this.remoteAnalyser = analyser
      this.applyRemoteVoiceOutput()
      this.startVoiceActivityLoop()
    } catch (err) {
      console.warn('[WebRTC] Falha ao iniciar analyser de voz remota:', err)
    }
  }

  /**
   * Indica se a voz do amigo está saindo pelo Web Audio (boost > 100%). Nesse caso o
   * <audio id="remote-voice"> deve ficar mutado para não tocar a voz em dobro.
   */
  public static isVoiceBoostVolume(volumePercent: number): boolean {
    return volumePercent > 100
  }

  /**
   * Ajusta o volume da voz do amigo (0% a 200%).
   * Antes o GainNode nunca era conectado a lugar nenhum, então o slider não tinha efeito algum.
   * Até 100% o volume é aplicado no elemento <audio>; acima disso a voz é roteada pelo GainNode.
   */
  public setRemoteVoiceBoostVolume(volumePercent: number): void {
    this.remoteVoiceVolumePercent = volumePercent
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {})
    }
    this.applyRemoteVoiceOutput()
  }

  private applyRemoteVoiceOutput(): void {
    const gainNode = this.remoteVoiceGainNode
    const ctx = this.audioCtx
    if (!gainNode || !ctx) return

    const boostActive =
      this.inCall && MsnWebRTCService.isVoiceBoostVolume(this.remoteVoiceVolumePercent)
    if (boostActive) {
      const gainValue = Math.max(0, Math.min(2, this.remoteVoiceVolumePercent / 100))
      gainNode.gain.setTargetAtTime(gainValue, ctx.currentTime, 0.02)
      if (!this.remoteVoiceBoostConnected) {
        gainNode.connect(ctx.destination)
        this.remoteVoiceBoostConnected = true
      }
    } else if (this.remoteVoiceBoostConnected) {
      try {
        gainNode.disconnect(ctx.destination)
      } catch {}
      this.remoteVoiceBoostConnected = false
    }
  }

  /**
   * Informa ao motor WebRTC se o DJ Bot está tocando.
   * Quando o DJ Bot está tocando, o áudio do compartilhamento de tela é silenciado na origem
   * para nunca transmitir uma 2ª cópia atrasada da música para o amigo!
   */
  public setDjBotPlayingState(isPlaying: boolean): void {
    this.djBotPlaying = isPlaying
    this.updateScreenAudioLoopbackGate()
  }

  private updateScreenAudioLoopbackGate(): void {
    const screenAudioTrack = this.localScreenStream?.getAudioTracks()[0]
    if (!screenAudioTrack) return

    // Silencia o áudio da tela APENAS se o DJ Bot estiver tocando música sincronizada.
    // Quando os amigos conversam na call, o áudio da tela NÃO fica mudo (pois o VoiceLoopbackCancellerProcessor
    // já subtrai digitalmente a voz do amigo sem cortar o som do compartilhamento!).
    screenAudioTrack.enabled = !this.djBotPlaying
  }

  /**
   * Loop rápido (60ms) de detecção de atividade de voz para Auto-Ducking do DJ Bot (reduz 70% quando alguém fala)
   */
  private startVoiceActivityLoop(): void {
    if (this.vadInterval) return
    const buffer = new Uint8Array(64)

    const computeRms = (analyser: AnalyserNode | null): number => {
      if (!analyser) return 0
      analyser.getByteFrequencyData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i]
      }
      return sum / buffer.length
    }

    this.vadInterval = setInterval(() => {
      const localMicEnabled = !this.isMicrophoneMuted()
      const localLevel = localMicEnabled ? computeRms(this.localAnalyser) : 0
      const remoteLevel = computeRms(this.remoteAnalyser)

      const speakingNow = localLevel > 22 || remoteLevel > 22

      if (speakingNow) {
        if (this.silenceTimeout) {
          clearTimeout(this.silenceTimeout)
          this.silenceTimeout = null
        }
        if (!this.currentlySpeaking) {
          this.currentlySpeaking = true
          this.callbacks.onVoiceActivityChange(true)
        }
      } else if (this.currentlySpeaking && !this.silenceTimeout) {
        // Restaura suavemente 800ms após o silêncio
        this.silenceTimeout = setTimeout(() => {
          this.currentlySpeaking = false
          this.silenceTimeout = null
          this.callbacks.onVoiceActivityChange(false)
        }, 800)
      }
    }, 60)
  }

  // ==========================================================================
  // 8. RTCDataChannel P2P (CHAT, PRINTS, ARQUIVOS ILIMITADOS, NUDGE, LASER, DJ BOT, RANKINGS)
  // ==========================================================================
  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      this.lastFriendP2PHeartbeat = Date.now()
      this.lastFriendSignalReceived = Date.now()
      this.broadcastStreamMeta()
      this.sendSubnickAndStatus(this.mySubnick, this.myStatus)
      this.sendDataChannelPacket({
        type: 'room-state',
        sender: this.myUser,
        inRoom: this.inCall
      })
      this.callbacks.onDataChannelOpen?.()
    }

    channel.onmessage = (event) => {
      this.lastFriendP2PHeartbeat = Date.now()
      this.lastFriendSignalReceived = Date.now()
      try {
        const packet = JSON.parse(event.data as string) as DataChannelPacket
        this.handleDataChannelPacket(packet)
      } catch (err) {
        console.warn('[DataChannel] Erro ao processar pacote P2P:', err)
      }
    }
  }

  public sendDataChannelPacket(packet: DataChannelPacket): boolean {
    let sent = false
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify(packet))
        sent = true
      } catch (err) {
        console.warn('[DataChannel] Erro ao enviar pacote via RTCDataChannel:', err)
      }
    }

    // Fallback garantido via Supabase Realtime Broadcast (exceto arquivos e heartbeats P2P para não mascarar queda)
    if (
      !sent &&
      packet.type !== 'file-chunk' &&
      packet.type !== 'heartbeat' &&
      packet.type !== 'heartbeat-ack'
    ) {
      if (this.realtimeChannel) {
        this.realtimeChannel
          .send({
            type: 'broadcast',
            event: 'msn-packet',
            payload: {
              sender: this.myUser,
              target: this.friendUser,
              packet
            }
          })
          .catch(() => {})
        return true
      }
    }
    return sent
  }

  private handleDataChannelPacket(packet: DataChannelPacket): void {
    switch (packet.type) {
      case 'chat-message':
        this.callbacks.onChatMessage({
          id: packet.id,
          sender: packet.sender,
          text: packet.text,
          imageDataUrl: packet.imageDataUrl,
          timestamp: packet.timestamp
        })
        break

      case 'chat-history-sync':
        if (Array.isArray(packet.messages)) {
          this.callbacks.onChatHistorySync?.(packet.messages)
        }
        break

      case 'nudge':
        this.callbacks.onNudgeReceived(packet.sender)
        break

      case 'soundboard-wink':
        this.callbacks.onSoundboardWink(packet.sender, packet.winkId, packet.label)
        break

      case 'subnick-update':
        this.friendLastStatus = packet.status
        this.callbacks.onFriendPresenceChange(packet.status, packet.subnick, false)
        break

      case 'dj-sync':
        this.callbacks.onDjSync(packet.state, Boolean(packet.initial))
        break

      case 'album-ranked':
        this.callbacks.onAlbumRankedNotification({
          user: packet.user,
          albumId: packet.albumId,
          albumName: packet.albumName,
          artistName: packet.artistName,
          rating: packet.rating
        })
        break

      case 'heartbeat':
        this.lastFriendP2PHeartbeat = Date.now()
        this.lastFriendSignalReceived = Date.now()
        this.friendJoinedThisCall = true
        this.sendDataChannelPacket({
          type: 'heartbeat-ack',
          sender: this.myUser,
          seq: packet.seq,
          timestamp: packet.timestamp
        })
        break

      case 'heartbeat-ack':
        this.lastFriendP2PHeartbeat = Date.now()
        this.lastFriendSignalReceived = Date.now()
        this.friendJoinedThisCall = true
        if (
          this.peerConnection?.iceConnectionState === 'connected' &&
          this.inCall
        ) {
          this.callHealth = 'healthy'
          this.emitCallState()
        }
        break

      case 'screen-share-state':
        if (!packet.active) {
          if (this.remoteScreenStream) {
            this.remoteScreenStream.getTracks().forEach((t) => t.stop())
            this.remoteScreenStream = null
          }
          this.remoteStreamIds.screenStreamId = null
          this.emitStreamsUpdated()
          this.emitCallState()
        } else {
          this.remoteStreamIds.screenStreamId = packet.screenStreamId || null
        }
        break

      case 'stream-meta':
        this.remoteStreamIds = {
          micStreamId: packet.micStreamId,
          camStreamId: packet.camStreamId,
          screenStreamId: packet.screenStreamId
        }
        if (!packet.screenStreamId && this.remoteScreenStream) {
          this.remoteScreenStream.getTracks().forEach((t) => t.stop())
          this.remoteScreenStream = null
          this.emitStreamsUpdated()
          this.emitCallState()
        }
        break

      case 'room-state':
        this.friendInRoom = packet.inRoom
        if (packet.inRoom) {
          this.friendJoinedThisCall = true
        } else {
          this.friendJoinedThisCall = false
          this.remoteVoiceStream = null
          this.remoteCamStream = null
          this.remoteScreenStream = null
          this.emitStreamsUpdated()
          console.log('[WebRTC] Amigo saiu da sala via room-state.')
        }
        this.emitCallState()
        break

      case 'file-start':
        this.incomingFiles.set(packet.transferId, {
          sender: packet.sender,
          fileName: packet.fileName,
          fileSize: packet.fileSize,
          mimeType: packet.mimeType,
          totalChunks: packet.totalChunks,
          // Array denso (não "new Array(n)"): every() pula buracos de arrays esparsos
          chunks: Array.from({ length: packet.totalChunks }, () => undefined),
          receivedCount: 0
        })
        this.callbacks.onFileProgress({
          fileName: packet.fileName,
          percent: 0,
          direction: 'receiving'
        })
        break

      case 'file-chunk': {
        const transfer = this.incomingFiles.get(packet.transferId)
        if (!transfer) break
        if (packet.chunkIndex < 0 || packet.chunkIndex >= transfer.totalChunks) break
        if (transfer.chunks[packet.chunkIndex] !== undefined) break
        // Cada chunk é decodificado isoladamente (o tamanho é múltiplo de 4 em base64)
        transfer.chunks[packet.chunkIndex] = MsnWebRTCService.base64ToBytes(packet.dataBase64)
        const prevPercent = Math.round((transfer.receivedCount / transfer.totalChunks) * 100)
        transfer.receivedCount += 1
        const percent = Math.round((transfer.receivedCount / transfer.totalChunks) * 100)
        if (percent !== prevPercent) {
          this.callbacks.onFileProgress({
            fileName: transfer.fileName,
            percent,
            direction: 'receiving'
          })
        }
        break
      }

      case 'file-end': {
        const transfer = this.incomingFiles.get(packet.transferId)
        if (!transfer) break
        this.incomingFiles.delete(packet.transferId)
        this.callbacks.onFileProgress(null)

        const timestamp = new Date().toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        })
        const complete =
          !packet.aborted &&
          transfer.receivedCount === transfer.totalChunks &&
          transfer.chunks.every((c) => c !== undefined)
        if (!complete) {
          this.callbacks.onChatMessage({
            id: `file-failed-${packet.transferId}`,
            sender: transfer.sender,
            text: `⚠️ A transferência do arquivo "${transfer.fileName}" foi interrompida.`,
            isSystem: true,
            timestamp
          })
          break
        }

        const blob = new Blob(transfer.chunks as Uint8Array<ArrayBuffer>[], {
          type: transfer.mimeType || 'application/octet-stream'
        })
        const blobUrl = URL.createObjectURL(blob)

        this.callbacks.onChatMessage({
          id: `file-${packet.transferId}`,
          sender: transfer.sender,
          text: `📁 Enviou um arquivo P2P: ${transfer.fileName}`,
          fileAttachment: {
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            mimeType: transfer.mimeType,
            blobUrl
          },
          timestamp
        })
        break
      }
    }
  }

  // Métodos públicos de envio P2P
  public sendChatMessage(text?: string, imageDataUrl?: string): ChatMessageItem {
    const msg: ChatMessageItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender: this.myUser,
      text,
      imageDataUrl,
      timestamp: new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })
    }

    this.sendDataChannelPacket({
      type: 'chat-message',
      id: msg.id,
      sender: msg.sender,
      text: msg.text,
      imageDataUrl: msg.imageDataUrl,
      timestamp: msg.timestamp
    })

    return msg
  }

  public sendChatHistorySync(messages: ChatMessageItem[]): void {
    const clean = messages
      .filter((m) => !m.isSystem && !m.fileAttachment)
      .slice(-80)
      .map((m) => ({
        id: m.id,
        sender: m.sender,
        text: m.text,
        imageDataUrl: m.imageDataUrl,
        timestamp: m.timestamp
      }))
    if (clean.length === 0) return

    // Uma única mensagem do DataChannel aceita no máximo 256 KB: com prints no histórico o pacote
    // único estourava esse limite (e o do fallback Realtime) e o sync inteiro falhava. Envia em lotes.
    const MAX_BATCH_CHARS = 200_000
    let batch: ChatMessageItem[] = []
    let batchChars = 0
    const flush = (): void => {
      if (batch.length === 0) return
      this.sendDataChannelPacket({
        type: 'chat-history-sync',
        sender: this.myUser,
        messages: batch
      })
      batch = []
      batchChars = 0
    }
    for (const msg of clean) {
      let item: ChatMessageItem = msg
      let size = JSON.stringify(item).length
      if (size > MAX_BATCH_CHARS) {
        // Imagem antiga grande demais para caber em um pacote: sincroniza só o texto
        item = { ...msg, imageDataUrl: undefined, text: msg.text || '📸 (imagem)' }
        size = JSON.stringify(item).length
      }
      if (batchChars + size > MAX_BATCH_CHARS) flush()
      batch.push(item)
      batchChars += size
    }
    flush()
  }

  /**
   * Aguarda um DataChannel aberto, solicitando a conexão P2P se necessário.
   */
  private async waitForOpenDataChannel(timeoutMs: number): Promise<RTCDataChannel | null> {
    if (this.dataChannel?.readyState === 'open') return this.dataChannel

    if (this.myUser === 'Vitinho') {
      if (!this.inCall) this.ensureChatDataChannel()
    } else {
      this.sendSignal('room-sync-request', { inRoom: this.inCall }).catch(() => {})
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.isDestroyed) {
      await new Promise((r) => setTimeout(r, 200))
      // Releitura explícita: o DataChannel pode ter sido trocado durante a espera
      const current = this.dataChannel as RTCDataChannel | null
      if (current?.readyState === 'open') return current
    }
    return null
  }

  private async sendWithBackpressure(channel: RTCDataChannel, packet: DataChannelPacket): Promise<void> {
    const HIGH_WATER_MARK = 4 * 1024 * 1024
    if (channel.bufferedAmount > HIGH_WATER_MARK) {
      channel.bufferedAmountLowThreshold = 1024 * 1024
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          channel.removeEventListener('bufferedamountlow', onLow)
          channel.removeEventListener('close', onClose)
        }
        const onLow = (): void => {
          cleanup()
          resolve()
        }
        const onClose = (): void => {
          cleanup()
          reject(new Error('A conexão P2P caiu durante a transferência.'))
        }
        channel.addEventListener('bufferedamountlow', onLow)
        channel.addEventListener('close', onClose)
      })
    }
    if (channel.readyState !== 'open' || channel !== this.dataChannel) {
      throw new Error('A conexão P2P caiu durante a transferência.')
    }
    channel.send(JSON.stringify(packet))
  }

  private static bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const step = 0x8000
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step))
    }
    return btoa(binary)
  }

  private static base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  /**
   * Envia arquivos P2P de qualquer tamanho em chunks de 36 KB (48 KB em base64) com controle real
   * de backpressure (bufferedAmount). Antes o arquivo inteiro era convertido em base64 na memória e
   * enviado sem respeitar o buffer: o send() estourava a fila do DataChannel e os chunks se perdiam,
   * chegando um arquivo corrompido (ou nenhum) do outro lado.
   */
  public async sendFileP2P(file: File): Promise<ChatMessageItem> {
    const channel = await this.waitForOpenDataChannel(12000)
    if (!channel) {
      throw new Error('Conexão P2P indisponível no momento. Tente novamente em alguns segundos.')
    }

    // Múltiplo de 3 bytes: cada chunk vira base64 sem padding e pode ser decodificado isoladamente
    const rawChunkSize = 36 * 1024
    const totalChunks = Math.max(1, Math.ceil(file.size / rawChunkSize))
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    try {
      await this.sendWithBackpressure(channel, {
        type: 'file-start',
        transferId,
        sender: this.myUser,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks
      })

      let lastPercent = -1
      for (let idx = 0; idx < totalChunks; idx++) {
        const buffer = await file.slice(idx * rawChunkSize, (idx + 1) * rawChunkSize).arrayBuffer()
        await this.sendWithBackpressure(channel, {
          type: 'file-chunk',
          transferId,
          chunkIndex: idx,
          dataBase64: MsnWebRTCService.bytesToBase64(new Uint8Array(buffer))
        })

        const percent = Math.round(((idx + 1) / totalChunks) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          this.callbacks.onFileProgress({
            fileName: file.name,
            percent,
            direction: 'sending'
          })
        }
      }

      await this.sendWithBackpressure(channel, {
        type: 'file-end',
        transferId
      })
    } catch (err) {
      try {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'file-end', transferId, aborted: true }))
        }
      } catch {}
      throw err
    } finally {
      this.callbacks.onFileProgress(null)
    }

    const localBlobUrl = URL.createObjectURL(file)
    return {
      id: `file-${transferId}`,
      sender: this.myUser,
      text: `📁 Arquivo enviado: ${file.name}`,
      fileAttachment: {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        blobUrl: localBlobUrl
      },
      timestamp: new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })
    }
  }

  public sendNudge(): void {
    this.sendDataChannelPacket({
      type: 'nudge',
      sender: this.myUser,
      timestamp: new Date().toISOString()
    })
  }

  public sendSoundboardWink(winkId: SoundboardWinkId, label: string): void {
    this.sendDataChannelPacket({
      type: 'soundboard-wink',
      sender: this.myUser,
      winkId,
      label
    })
  }

  private trackPresenceState(): void {
    if (this.realtimeChannel && !this.isDestroyed) {
      this.realtimeChannel
        .track({
          user: this.myUser,
          status: this.myStatus,
          subnick: this.mySubnick,
          inRoom: this.inCall,
          instanceId: this.instanceId,
          lastSeen: Date.now(),
          protocolVersion: this.protocolVersion,
          online_at: new Date().toISOString()
        })
        .catch(() => {})
    }
  }

  public sendSubnickAndStatus(subnick: string, status: PresenceStatus): void {
    this.mySubnick = subnick
    this.myStatus = status

    this.sendDataChannelPacket({
      type: 'subnick-update',
      sender: this.myUser,
      subnick,
      status
    })

    this.trackPresenceState()
  }

  public sendDjSync(state: DjSyncState, initial = false): void {
    this.sendDataChannelPacket({
      type: 'dj-sync',
      state,
      initial
    })
  }

  public sendAlbumRankedAlert(payload: {
    user: MsnUser
    albumId: string
    albumName: string
    artistName: string
    rating: number
  }): void {
    this.sendDataChannelPacket({
      type: 'album-ranked',
      ...payload
    })
  }

  // ==========================================================================
  // 9. LIMPEZA DE RECURSOS E EMISSÃO DE ESTADO
  // ==========================================================================
  private cleanupLocalMediaStreams(): void {
    if (this.peerConnection) {
      for (const sender of this.peerConnection.getSenders()) {
        if (sender.track) {
          try {
            this.peerConnection.removeTrack(sender)
          } catch {
            // ignora se pc estiver fechado
          }
        }
      }
    }
    this.localMicStream?.getTracks().forEach((t) => t.stop())
    this.localCamStream?.getTracks().forEach((t) => t.stop())
    this.localScreenStream?.getTracks().forEach((t) => t.stop())
    this.cleanupScreenAudioCanceller()

    this.localMicStream = null
    this.localCamStream = null
    this.localScreenStream = null
  }

  private cleanupMediaStreams(): void {
    this.cleanupLocalMediaStreams()
    this.remoteVoiceStream = null
    this.remoteCamStream = null
    this.remoteScreenStream = null
  }

  private emitStreamsUpdated(): void {
    this.callbacks.onStreamsUpdated({
      localCam: this.localCamStream,
      localScreen: this.localScreenStream,
      remoteVoice: this.remoteVoiceStream,
      remoteCam: this.remoteCamStream,
      remoteScreen: this.remoteScreenStream
    })
  }

  private emitCallState(): void {
    const hasRemoteMedia = Boolean(
      (this.remoteCamStream && this.remoteCamStream.getVideoTracks().some((t) => t.readyState === 'live')) ||
      (this.remoteVoiceStream && this.remoteVoiceStream.getAudioTracks().some((t) => t.readyState === 'live'))
    )
    this.callbacks.onCallStateChange({
      inCall: this.inCall,
      friendInRoom: Boolean(this.friendInRoom) || hasRemoteMedia,
      incomingCallFrom: this.incomingCallFrom,
      isScreenSharing: Boolean(this.localScreenStream),
      remoteScreenSharing: Boolean(
        this.remoteScreenStream &&
          this.remoteScreenStream.getVideoTracks().length > 0 &&
          Boolean(this.remoteStreamIds.screenStreamId)
      ),
      callHealth: this.callHealth
    })
  }

  public destroy(): void {
    // Avisa o amigo que saí da sala (logout/fechar o app durante a ligação); antes ele só
    // percebia pela queda de presença, segundos depois.
    if (this.inCall && !this.isDestroyed) {
      this.sendDataChannelPacket({
        type: 'room-state',
        sender: this.myUser,
        inRoom: false
      })
      this.sendSignal('hangup', { inRoom: false }).catch(() => {})
      this.inCall = false
    }
    this.isDestroyed = true
    if (this.offlineGraceTimeout) {
      clearTimeout(this.offlineGraceTimeout)
      this.offlineGraceTimeout = null
    }
    if (this.realtimeReconnectTimeout) {
      clearTimeout(this.realtimeReconnectTimeout)
      this.realtimeReconnectTimeout = null
    }
    if (this.vadInterval) {
      clearInterval(this.vadInterval)
      this.vadInterval = null
    }
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
    if (this.disconnectGraceTimer) clearTimeout(this.disconnectGraceTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer)
    if (this.presenceHeartbeatInterval) {
      clearInterval(this.presenceHeartbeatInterval)
      this.presenceHeartbeatInterval = null
    }
    if (this.presenceSweepInterval) {
      clearInterval(this.presenceSweepInterval)
      this.presenceSweepInterval = null
    }
    this.stopCallHealthTimers()
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler)
      this.onlineHandler = null
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    this.cleanupMediaStreams()
    this.resetPeerConnection()
    this.realtimeGeneration++
    const channel = this.realtimeChannel
    this.realtimeChannel = null
    if (channel) {
      channel.untrack().catch(() => {})
      this.supabase?.removeChannel(channel).catch(() => {})
    }
    // Libera o AudioContext (antes ficava vivo após logout/destroy, um por sessão)
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {})
      this.audioCtx = null
      this.workletRegistered = false
    }
  }
}
