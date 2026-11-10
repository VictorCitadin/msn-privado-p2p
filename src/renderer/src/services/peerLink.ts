import type { MsnWebRTCService } from './webrtc'
import {
  CallHealth,
  ChatMessageItem,
  DataChannelPacket,
  MsnUser,
  PresenceStatus,
  RemoteStreamIds,
  isOffererFor
} from './types'

type SignalType =
  | 'sdp-offer'
  | 'sdp-answer'
  | 'ice-candidate'
  | 'hangup'
  | 'renegotiate-offer'
  | 'room-sync-request'
  | 'screen-share-state'
  | 'p2p-heartbeat'
  | 'reconnect-request'

interface IncomingFileBuffer {
  sender: MsnUser
  fileName: string
  fileSize: number
  mimeType: string
  totalChunks: number
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>
  receivedCount: number
}

export interface PresenceEntry {
  user?: string
  status?: PresenceStatus
  subnick?: string
  inRoom?: boolean
  instanceId?: string
  lastSeen?: number
  online_at?: string
  protocolVersion?: number
}

const emptyStreamIds = (): RemoteStreamIds => ({
  micStreamId: null,
  camStreamId: null,
  screenStreamId: null
})

/**
 * Conexão P2P com UM amigo (RTCPeerConnection + DataChannel + presença daquele amigo).
 * O MsnWebRTCService mantém um PeerLink por amigo (malha): com Vitinho, Will e Nath online,
 * cada um tem duas conexões. A mídia local (mic/câmera/tela) e o canal Realtime são compartilhados.
 *
 * Em cada par, quem vem primeiro na ordem Vitinho → Will → Nath é o "offerer" (impolite peer):
 * cria as ofertas oficiais; o outro pede ofertas via 'room-sync-request'.
 */
export class PeerLink {
  readonly isOfferer: boolean
  private readonly isPolite: boolean

  peerConnection: RTCPeerConnection | null = null
  dataChannel: RTCDataChannel | null = null

  remoteVoiceStream: MediaStream | null = null
  remoteCamStream: MediaStream | null = null
  remoteScreenStream: MediaStream | null = null
  private remoteStreamIds: RemoteStreamIds = emptyStreamIds()
  private remoteTrackStreamIds: Map<string, string> = new Map()

  private pendingIceCandidates: Array<{ candidate: RTCIceCandidateInit; pcId: string | null }> = []
  private makingOffer = false
  private ignoreOffer = false
  private localPcId: string | null = null
  private remotePcId: string | null = null
  private lastChatOfferAt = 0

  friendInRoom = false
  friendLastStatus: PresenceStatus = 'offline'
  private friendLastSubnick = ''
  private friendPresenceReceivedAt = 0
  private lastFriendP2PHeartbeat = 0
  private lastFriendSignalReceived = 0
  private offlineGraceTimeout: ReturnType<typeof setTimeout> | null = null

  callHealth: CallHealth = 'connecting'
  private friendJoinedThisCall = false
  private callHealthInterval: ReturnType<typeof setInterval> | null = null
  private p2pHeartbeatInterval: ReturnType<typeof setInterval> | null = null
  private p2pHeartbeatSeq = 0
  private iceRestartAttempts = 0
  private fullReconnectAttempts = 0
  private lastAudioBytesReceived = 0
  private lastAudioBytesStallCount = 0
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectResetTimer: ReturnType<typeof setTimeout> | null = null
  private isReconnecting = false

  // Voz deste amigo no Web Audio (VAD + boost acima de 100%)
  private remoteVoiceSourceNode: MediaStreamAudioSourceNode | null = null
  private remoteVoiceGainNode: GainNode | null = null
  private remoteVoiceBoostConnected = false
  remoteAnalyser: AnalyserNode | null = null

  private incomingFiles: Map<string, IncomingFileBuffer> = new Map()

  private negotiationQueue: Promise<void> = Promise.resolve()
  private renegotiationQueued = false
  // Esperas por sinalização estável: liberadas quando a PeerConnection é descartada
  // (pc.close() não dispara 'signalingstatechange', então a espera ficava pendurada até o timeout)
  private stableWaiters: Set<() => void> = new Set()
  private pcCreatedAt = 0
  private lastRoomSyncRequestAt = 0

  constructor(
    private readonly host: MsnWebRTCService,
    readonly friend: MsnUser
  ) {
    this.isOfferer = isOffererFor(host.myUser, friend)
    this.isPolite = !this.isOfferer
  }

  private get myUser(): MsnUser {
    return this.host.myUser
  }

  private get inCall(): boolean {
    return this.host.inCall
  }

  private emitStreamsUpdated(): void {
    this.host.emitStreamsUpdated()
  }

  private emitCallState(): void {
    this.host.emitCallState()
  }

  // ==========================================================================
  // PRESENÇA DESTE AMIGO
  // ==========================================================================
  handlePresenceSync(rawList: PresenceEntry[]): void {
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
          this.clearRemoteStreams()
          this.emitStreamsUpdated()
          console.log(`[WebRTC] ${this.friend} saiu da sala (presença).`)
        }
        this.emitCallState()
      }
      this.host.callbacks.onFriendPresenceChange(this.friend, newStatus, newSubnick, justLoggedIn)

      const isDisconnected = !this.peerConnection || this.peerConnection.signalingState === 'closed'
      if (this.inCall && latest.inRoom) {
        if (isDisconnected) {
          if (this.isOfferer) {
            console.log(`[WebRTC] Eu e ${this.friend} na Sala sem conexão: enviando oferta...`)
            this.joinRoomNegotiation().catch(() => {})
          } else {
            console.log(`[WebRTC] Eu e ${this.friend} na Sala sem conexão: solicitando oferta...`)
            this.requestOfferThrottled({ inRoom: true })
          }
        } else if (this.isOfferer && this.peerConnection?.signalingState === 'stable') {
          const hasMedia = this.peerConnection.getSenders().some((s) => s.track !== null)
          if (!hasMedia) {
            console.log(`[WebRTC] Conexão com ${this.friend} sem mídia: renegociando chamada...`)
            this.renegotiatePeerConnection().catch(() => {})
          }
        }
      } else if (!this.inCall && latest.inRoom) {
        // O amigo está na sala e eu ainda estou no chat: recebo a câmera dele no avatar do chat
        if (this.isOfferer) {
          const hasVideoRecv = this.peerConnection
            ?.getTransceivers()
            .some((t) => t.receiver.track?.kind === 'video')
          if (isDisconnected || !hasVideoRecv) {
            console.log(`[WebRTC] ${this.friend} está na sala e eu no chat: conectando para receber câmera...`)
            this.connectReceiveOnlyCall().catch(() => {})
          }
        } else if (friendStateChanged || !this.peerConnection) {
          console.log(`[WebRTC] ${this.friend} está na sala e eu no chat: solicitando preview de câmera...`)
          this.requestOfferThrottled({ inRoom: false, wantsPreview: true })
        }
      } else if (this.inCall && !latest.inRoom) {
        // Eu estou na sala e o amigo está no chat: envio meu stream para o preview dele
        if (this.isOfferer) {
          if (isDisconnected) {
            this.rebuildCall().catch(() => {})
          } else if (friendStateChanged) {
            console.log(`[WebRTC] Eu na sala e ${this.friend} no chat: enviando stream para preview...`)
            this.renegotiatePeerConnection().catch(() => {})
          }
        }
      } else if (this.isOfferer) {
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
  }

  /**
   * Pedido de oferta disparado pela presença: com três pessoas online o evento de presença chega
   * várias vezes por segundo, e cada pedido fazia o offerer recriar a conexão (livelock).
   */
  private requestOfferThrottled(data: Record<string, unknown>): void {
    if (Date.now() - this.lastRoomSyncRequestAt < 3000) return
    this.lastRoomSyncRequestAt = Date.now()
    this.sendSignal('room-sync-request', data).catch(() => {})
  }

  noteFriendActivity(): void {
    this.lastFriendSignalReceived = Date.now()
  }

  sweepPresence(presenceList: unknown[] | null): void {
    const isOnline = this.computeIsFriendOnline(presenceList)
    if (isOnline && this.friendLastStatus === 'offline') {
      // Se o amigo voltou a responder sinais ou P2P, emite online imediatamente
      this.friendLastStatus = 'online'
      this.host.callbacks.onFriendPresenceChange(this.friend, 'online', this.friendLastSubnick || '', true)
      this.emitCallState()
    } else if (!isOnline && this.friendLastStatus !== 'offline') {
      console.log(`[WebRTC] Timeout de presença/sinais de ${this.friend}: marcando como offline.`)
      this.markFriendOffline()
    }

    // Reabre o DataChannel do chat caso a oferta anterior tenha se perdido ou a conexão tenha falhado
    if (isOnline && !this.inCall && this.isOfferer) {
      this.ensureChatDataChannel()
    }
  }

  /**
   * @param presenceList lista de presença do amigo, ou null quando a presença é incerta
   * (canal Realtime sendo recriado ou recém-inscrito, ainda sem o primeiro sync)
   */
  private computeIsFriendOnline(presenceList: unknown[] | null): boolean {
    const now = Date.now()
    const p2pActive = this.lastFriendP2PHeartbeat > 0 && now - this.lastFriendP2PHeartbeat < 15000
    const signalActive =
      this.lastFriendSignalReceived > 0 && now - this.lastFriendSignalReceived < 30000

    // Presença incerta: mantém o status atual para não gerar um falso "offline" seguido de um
    // falso "acabou de entrar".
    if (presenceList === null) {
      return this.friendLastStatus !== 'offline' || p2pActive || signalActive
    }
    if (presenceList.length > 0) return true
    return p2pActive || signalActive
  }

  get isFriendOnline(): boolean {
    return this.friendLastStatus !== 'offline'
  }

  /**
   * (Offerer) Garante um DataChannel de chat aberto quando eu não estou na sala.
   * Se a oferta inicial se perdesse (amigo offline) ou o ICE falhasse fora de ligação,
   * a PeerConnection ficava presa e o chat dependia só do fallback Realtime para sempre.
   */
  ensureChatDataChannel(): void {
    if (!this.isOfferer || this.host.isDestroyed || this.inCall) return
    if (this.dataChannel?.readyState === 'open') return

    const pc = this.peerConnection
    if (pc && pc.signalingState !== 'closed') {
      const stillNegotiating =
        pc.connectionState === 'new' ||
        pc.connectionState === 'connecting' ||
        this.dataChannel?.readyState === 'connecting'
      if (stillNegotiating && Date.now() - this.lastChatOfferAt < 15000) return
    }

    console.log(`[WebRTC] DataChannel com ${this.friend} indisponível: recriando conexão P2P...`)
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
      this.clearRemoteStreams()
      this.emitStreamsUpdated()
      this.emitCallState()
    }

    if (wasOnline) {
      this.host.callbacks.onFriendPresenceChange(this.friend, 'offline', 'Offline', false)
    }
  }

  private clearRemoteStreams(): void {
    this.remoteVoiceStream = null
    this.remoteCamStream = null
    this.remoteScreenStream = null
  }

  private async sendSignal(type: SignalType, data: Record<string, unknown>): Promise<void> {
    // pcId = minha PeerConnection atual; remotePcId = a do amigo com quem ela está pareada
    await this.host.sendSignalTo(this.friend, type, {
      pcId: this.localPcId,
      remotePcId: this.remotePcId,
      ...data
    })
  }

  // ==========================================================================
  // RTCPeerConnection E SEPARAÇÃO DE TRACKS
  // ==========================================================================
  private ensurePeerConnection(): RTCPeerConnection {
    if (this.peerConnection && this.peerConnection.signalingState !== 'closed') {
      return this.peerConnection
    }

    const pc = new RTCPeerConnection({
      iceServers: this.host.getIceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })
    this.localPcId = `${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
    this.remotePcId = null
    this.remoteTrackStreamIds.clear()
    this.pcCreatedAt = Date.now()

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
      console.log(`[WebRTC] ICE ${this.friend}:`, pc.iceConnectionState)
      if (pc.iceConnectionState === 'connected') {
        if (this.disconnectGraceTimer) {
          clearTimeout(this.disconnectGraceTimer)
          this.disconnectGraceTimer = null
        }
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }

        // Contadores de tentativa de reconexão só voltam a zero após 10s contínuos e estáveis
        if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer)
        this.reconnectResetTimer = setTimeout(() => {
          if (this.peerConnection?.iceConnectionState === 'connected') {
            this.iceRestartAttempts = 0
            this.fullReconnectAttempts = 0
            this.reconnectResetTimer = null
          }
        }, 10000)

        if (Date.now() - this.lastFriendP2PHeartbeat < 6000) {
          this.callHealth = 'healthy'
        }
        this.emitCallState()
      } else if (pc.iceConnectionState === 'disconnected') {
        this.callHealth = 'degraded'
        this.emitCallState()
        // Timer de graça de 2.5s antes de forçar reconexão. Se virar failed antes, o failed assume.
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
      streams && streams.length > 0 ? streams[0].id : this.remoteTrackStreamIds.get(track.id) || null

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
      } else if (
        !this.remoteVoiceStream ||
        !this.remoteVoiceStream.getAudioTracks().some((t) => t.id === track.id)
      ) {
        // Voz do amigo: trilha primária do microfone
        this.remoteVoiceStream = new MediaStream([track])
        this.setupRemoteVoiceAnalyser(this.remoteVoiceStream)
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
      } else if (
        !this.remoteCamStream ||
        !this.remoteCamStream.getVideoTracks().some((t) => t.id === track.id)
      ) {
        // Câmera do amigo
        this.remoteCamStream = new MediaStream([track])
      }
    }

    track.onended = () => {
      const removeFrom = (stream: MediaStream | null): boolean => {
        if (stream && stream.getTracks().some((t) => t.id === track.id)) {
          stream.removeTrack(track)
          return true
        }
        return false
      }
      if (removeFrom(this.remoteScreenStream) && this.remoteScreenStream?.getVideoTracks().length === 0) {
        this.remoteScreenStream = null
      }
      if (removeFrom(this.remoteCamStream) && this.remoteCamStream?.getVideoTracks().length === 0) {
        this.remoteCamStream = null
      }
      if (removeFrom(this.remoteVoiceStream) && this.remoteVoiceStream?.getAudioTracks().length === 0) {
        this.remoteVoiceStream = null
      }
      this.emitStreamsUpdated()
      this.emitCallState()
    }

    this.emitStreamsUpdated()
    this.emitCallState()
  }

  /**
   * Transceivers pelos quais o amigo realmente envia mídia para mim. Os que eu criei só para
   * enviar (ex: os da minha tela compartilhada) também têm um receiver com uma trilha "viva",
   * porém vazia/mutada: tratá-la como trilha do amigo deixava a câmera dele preta e a voz muda.
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

  // ==========================================================================
  // FILA DE OFERTAS (uma negociação por vez em cada conexão)
  // ==========================================================================

  /**
   * Toda oferta deste link passa por esta fila. Antes, gatilhos simultâneos (pedido do amigo +
   * evento de presença + entrar na sala) criavam várias ofertas seguidas; a resposta da primeira
   * era aplicada sobre a última e a câmera de um dos lados ficava negociada como "só receber".
   */
  private queueNegotiation(task: () => Promise<void>): Promise<void> {
    const run = this.negotiationQueue.then(task, task)
    this.negotiationQueue = run.catch(() => {})
    return run
  }

  /** Garante sinalização estável antes de uma nova oferta (desfaz uma oferta antiga sem resposta). */
  private async prepareForOffer(pc: RTCPeerConnection): Promise<boolean> {
    if (pc.signalingState === 'stable') return true
    if (await this.waitForStableSignaling(pc)) return true
    if (pc.signalingState === 'have-local-offer') {
      try {
        // A oferta anterior nunca foi respondida: descarta para não travar a fila
        await pc.setLocalDescription({ type: 'rollback' })
      } catch {}
    }
    // Releitura após os awaits (o estado mudou desde a checagem inicial)
    return (pc.signalingState as RTCSignalingState) === 'stable'
  }

  private async createAndSendOffer(
    pc: RTCPeerConnection,
    signal: 'sdp-offer' | 'renegotiate-offer',
    buildData: () => Record<string, unknown>,
    options?: RTCOfferOptions,
    beforeOffer?: () => Promise<void> | void
  ): Promise<void> {
    if (!(await this.prepareForOffer(pc)) || pc !== this.peerConnection) return
    if (beforeOffer) await beforeOffer()
    this.makingOffer = true
    try {
      const offer = await pc.createOffer(options)
      if (pc.signalingState === 'closed' || pc !== this.peerConnection) return
      await this.setLocalDescriptionSafe(pc, offer)
      await this.sendSignal(signal, {
        sdp: pc.localDescription,
        streamIds: this.host.getLocalStreamIds(),
        ...buildData()
      })
    } finally {
      this.makingOffer = false
    }
  }

  async connectDataChannelOnly(): Promise<void> {
    const pc = this.ensurePeerConnection()
    if (!this.dataChannel) {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    this.lastChatOfferAt = Date.now()
    await this.queueNegotiation(() =>
      this.createAndSendOffer(pc, 'sdp-offer', () => ({ isMediaCall: false }))
    )
  }

  async connectReceiveOnlyCall(): Promise<void> {
    const pc = this.ensurePeerConnection()
    if (!this.dataChannel || this.dataChannel.readyState === 'closed') {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    const transceivers = pc.getTransceivers()
    if (!transceivers.find((t) => t.receiver.track?.kind === 'video')) {
      pc.addTransceiver('video', { direction: 'recvonly' })
    }
    if (!transceivers.find((t) => t.receiver.track?.kind === 'audio')) {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }

    if (this.isOfferer) {
      this.lastChatOfferAt = Date.now()
      await this.queueNegotiation(() =>
        this.createAndSendOffer(
          pc,
          'sdp-offer',
          () => ({ isMediaCall: true, inRoom: this.inCall }),
          { offerToReceiveAudio: true, offerToReceiveVideo: true },
          () => this.broadcastStreamMeta()
        )
      )
    }
  }

  private async setLocalDescriptionSafe(
    pc: RTCPeerConnection,
    desc: RTCSessionDescriptionInit
  ): Promise<void> {
    try {
      const munged: RTCSessionDescriptionInit = {
        type: desc.type,
        sdp: mungeSdpForHardwareH264AndOpus(desc.sdp || '')
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
  // SALA (LIGAÇÃO)
  // ==========================================================================

  /** Chamado pelo serviço quando EU entro na sala (mídia local já adquirida). */
  async onLocalJoinRoom(): Promise<void> {
    this.callHealth = 'connecting'
    this.iceRestartAttempts = 0
    this.fullReconnectAttempts = 0
    this.friendJoinedThisCall = false
    this.p2pHeartbeatSeq = 0
    this.startCallHealthTimers()
    this.applyRemoteVoiceOutput()

    // Amigo offline e sem conexão: não há com quem negociar agora. Quando ele ficar online,
    // a presença dispara a negociação (handlePresenceSync).
    if (!this.isFriendOnline && !this.peerConnection) return
    await this.joinRoomNegotiation()
  }

  private async joinRoomNegotiation(): Promise<void> {
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

    // O offerer do par cria a oferta oficial; o outro prepara seus streams e pede a oferta.
    if (this.isOfferer) {
      // A fila espera uma oferta anterior sem resposta (ex: a de "só receber" do chat) terminar
      await this.queueNegotiation(() =>
        this.createAndSendOffer(
          pc,
          'sdp-offer',
          () => ({ isMediaCall: true, inRoom: true }),
          { offerToReceiveAudio: true, offerToReceiveVideo: true },
          async () => {
            this.attachLocalStreamsToPeer(pc)
            await this.ensureTransceiversSendRecv(pc)
            this.broadcastStreamMeta()
            this.sendDataChannelPacket({ type: 'room-state', sender: this.myUser, inRoom: true })
          }
        )
      )
    } else {
      this.sendDataChannelPacket({
        type: 'room-state',
        sender: this.myUser,
        inRoom: true
      })
      await this.sendSignal('room-sync-request', { inRoom: true })
    }
  }

  /** Chamado pelo serviço quando EU saio da sala (mídia local já liberada). */
  onLocalLeaveRoom(): void {
    this.callHealth = 'dead'
    this.stopCallHealthTimers()
    this.applyRemoteVoiceOutput()
    this.clearRemoteStreams()
    this.remoteStreamIds = emptyStreamIds()

    // 1. Notifica o amigo via DataChannel e Realtime antes de fechar a conexão
    this.sendDataChannelPacket({
      type: 'room-state',
      sender: this.myUser,
      inRoom: false
    })
    this.sendSignal('hangup', { inRoom: false }).catch(() => {})

    // 2. Limpa e reinicia o PeerConnection (o offerer reabre o chat / preview)
    this.resetPeerConnection()
    if (this.isOfferer && this.isFriendOnline) {
      const connect = this.friendInRoom ? this.connectReceiveOnlyCall() : this.connectDataChannelOnly()
      connect.catch(() => {})
    }
  }

  async ensureTransceiversSendRecv(pc: RTCPeerConnection): Promise<void> {
    const transceivers = pc.getTransceivers()
    const micStream = this.host.localMicStream
    const camStream = this.host.localCamStream
    const micTrack = micStream?.getAudioTracks()[0]
    const camTrack = camStream?.getVideoTracks()[0]

    // Os transceivers da tela compartilhada nunca podem ser tratados como mic/câmera: sem webcam
    // (ou sem microfone) o transceiver da tela era o primeiro do tipo e acabava virando 'recvonly'.
    const screenTrackIds = new Set((this.host.localScreenStream?.getTracks() || []).map((t) => t.id))
    const isScreenTransceiver = (t: RTCRtpTransceiver): boolean =>
      Boolean(t.sender.track && screenTrackIds.has(t.sender.track.id))
    const directionFor = (t: RTCRtpTransceiver, localTrack?: MediaStreamTrack): RTCRtpTransceiverDirection =>
      localTrack || t.sender.track ? 'sendrecv' : 'recvonly'

    // Áudio da Voz (Microfone)
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
        streams: micStream ? [micStream] : []
      })
      if (micTrack) {
        const t = pc.getTransceivers().find((x) => x.receiver.track?.kind === 'audio')
        if (t?.sender) {
          await t.sender.replaceTrack(micTrack).catch(() => {})
        }
      }
    }

    // Vídeo da Câmera (Webcam)
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
        streams: camStream ? [camStream] : []
      })
      if (camTrack) {
        const t = pc.getTransceivers().find((x) => x.receiver.track?.kind === 'video')
        if (t?.sender) {
          await t.sender.replaceTrack(camTrack).catch(() => {})
        }
      }
    }
  }

  attachLocalStreamsToPeer(pc: RTCPeerConnection): void {
    const existingSenders = pc.getSenders()
    const addStreamTracks = (stream: MediaStream | null): void => {
      if (!stream) return
      for (const track of stream.getTracks()) {
        if (!existingSenders.some((s) => s.track?.id === track.id)) {
          pc.addTrack(track, stream)
        }
      }
    }
    addStreamTracks(this.host.localMicStream)
    addStreamTracks(this.host.localCamStream)
    addStreamTracks(this.host.localScreenStream)
  }

  /** Remove da PeerConnection os senders das trilhas informadas (ex: ao parar a tela / sair da sala). */
  removeLocalTracks(tracks: MediaStreamTrack[]): void {
    const pc = this.peerConnection
    if (!pc) return
    for (const sender of pc.getSenders()) {
      if (sender.track && tracks.some((t) => t.id === sender.track?.id)) {
        try {
          pc.removeTrack(sender)
        } catch {
          // ignora se pc estiver fechado
        }
      }
    }
  }

  /** Troca ao vivo uma trilha local (troca de microfone/webcam no meio da ligação). */
  async replaceLocalTrack(
    kind: 'audio' | 'video',
    oldTrack: MediaStreamTrack | undefined,
    newTrack: MediaStreamTrack,
    newStream: MediaStream
  ): Promise<void> {
    const pc = this.peerConnection
    if (!pc) return
    const screenTrackIds = new Set((this.host.localScreenStream?.getTracks() || []).map((t) => t.id))
    const sender = pc
      .getSenders()
      .find(
        (s) =>
          s.track?.kind === kind &&
          !screenTrackIds.has(s.track.id) &&
          (!oldTrack || s.track.id === oldTrack.id)
      )
    if (sender) {
      await sender.replaceTrack(newTrack)
    } else {
      pc.addTrack(newTrack, newStream)
    }
  }

  /** Configura 10 Mbps / 60 fps no sender da tela compartilhada. */
  async applyScreenSenderParameters(screenVideoTrack: MediaStreamTrack): Promise<void> {
    const pc = this.peerConnection
    if (!pc) return
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.id === screenVideoTrack.id) {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = 10_000_000
        params.encodings[0].maxFramerate = 60
        await sender.setParameters(params).catch(() => {})
      }
    }
  }

  async startScreenShare(screenStream: MediaStream): Promise<void> {
    if (!this.isFriendOnline && !this.peerConnection) return
    const pc = this.ensurePeerConnection()
    this.attachLocalStreamsToPeer(pc)
    const screenVideoTrack = screenStream.getVideoTracks()[0]
    if (screenVideoTrack) {
      await this.applyScreenSenderParameters(screenVideoTrack)
    }
    this.sendDataChannelPacket({
      type: 'screen-share-state',
      sender: this.myUser,
      active: true,
      screenStreamId: screenStream.id
    })
    this.sendSignal('screen-share-state', {
      sender: this.myUser,
      active: true,
      screenStreamId: screenStream.id
    }).catch(() => {})
    await this.renegotiatePeerConnection()
  }

  async stopScreenShare(screenTracks: MediaStreamTrack[]): Promise<void> {
    this.sendDataChannelPacket({
      type: 'screen-share-state',
      sender: this.myUser,
      active: false
    })
    this.sendSignal('screen-share-state', {
      sender: this.myUser,
      active: false
    }).catch(() => {})
    this.removeLocalTracks(screenTracks)
  }

  /**
   * Aguarda a negociação em andamento (oferta sem resposta) terminar.
   * @returns true se a sinalização ficou estável a tempo
   */
  private waitForStableSignaling(pc: RTCPeerConnection, timeoutMs = 6000): Promise<boolean> {
    if (pc.signalingState === 'stable') return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        pc.removeEventListener('signalingstatechange', onChange)
        this.stableWaiters.delete(finish)
        resolve(pc.signalingState === 'stable' && pc === this.peerConnection)
      }
      this.stableWaiters.add(finish)
      const onChange = (): void => {
        if (pc.signalingState === 'stable' || pc.signalingState === 'closed') finish()
      }
      const timer = setTimeout(finish, timeoutMs)
      pc.addEventListener('signalingstatechange', onChange)
    })
  }

  async renegotiatePeerConnection(): Promise<void> {
    const pc = this.peerConnection
    if (!pc || pc.signalingState === 'closed') return
    // Vários pedidos seguidos (tela + presença + pedido do amigo) viram uma única renegociação.
    // Antes, pedidos com a sinalização instável eram descartados e nunca aconteciam.
    if (this.renegotiationQueued) return
    this.renegotiationQueued = true
    await this.queueNegotiation(async () => {
      this.renegotiationQueued = false
      if (pc !== this.peerConnection) return
      await this.createAndSendOffer(
        pc,
        'renegotiate-offer',
        () => ({
          isMediaCall: this.inCall || Boolean(this.remoteCamStream || this.host.localCamStream),
          inRoom: this.inCall
        }),
        { offerToReceiveAudio: true, offerToReceiveVideo: true },
        async () => {
          if (this.inCall) {
            this.attachLocalStreamsToPeer(pc)
            await this.ensureTransceiversSendRecv(pc)
          }
          this.broadcastStreamMeta()
        }
      )
    })
  }

  // ==========================================================================
  // SAÚDE DA LIGAÇÃO E RECONEXÃO
  // ==========================================================================
  private startCallHealthTimers(): void {
    this.stopCallHealthTimers()
    this.lastAudioBytesReceived = 0
    this.lastAudioBytesStallCount = 0

    // 1. Heartbeat P2P a cada 2s pelo DataChannel + Fallback Realtime Broadcast a cada 6s
    this.p2pHeartbeatInterval = setInterval(() => {
      if (!this.inCall || !this.isFriendOnline) return
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

      // Mais de 15 segundos sem NENHUM sinal, heartbeat ou presença do amigo: ele caiu
      const noP2pHeartbeat =
        this.lastFriendP2PHeartbeat > 0 && now - this.lastFriendP2PHeartbeat > 15000
      const noSignal =
        this.lastFriendSignalReceived > 0 && now - this.lastFriendSignalReceived > 15000
      const noPresence =
        this.friendPresenceReceivedAt > 0 && now - this.friendPresenceReceivedAt > 20000

      if (noP2pHeartbeat && noSignal && noPresence && this.friendJoinedThisCall) {
        console.warn(`[WebRTC] Timeout crítico (15s sem sinal de ${this.friend}).`)
        this.host.onLinkCallDead(this, `${this.friend} perdeu a conexão com a sala há mais de 15 segundos.`)
        return
      }

      // Verificação de mídia real via getStats() EXCLUSIVAMENTE no receptor da voz
      const pc = this.peerConnection
      if (pc && pc.connectionState === 'connected' && !this.isReconnecting) {
        try {
          const audioTransceivers = this.getReceivingTransceivers().filter(
            (t) => t.receiver.track?.kind === 'audio'
          )

          if (audioTransceivers.length > 0 && this.friendInRoom && this.friendJoinedThisCall) {
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
                  console.warn(
                    `[WebRTC] Voz de ${this.friend} estagnada há mais de 6s. Acionando reconexão preventiva...`
                  )
                  this.lastAudioBytesStallCount = 0
                  this.callHealth = 'degraded'
                  this.emitCallState()
                  this.handleConnectionFailure()
                }
              } else {
                this.lastAudioBytesReceived = currentAudioBytes
                this.lastAudioBytesStallCount = 0
                if (this.callHealth !== 'healthy' && Date.now() - this.lastFriendP2PHeartbeat < 6000) {
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

  /**
   * O amigo caiu da ligação, mas eu continuo na sala com outros amigos:
   * descarta a conexão com ele e volta a esperar (a presença reconecta quando ele voltar).
   */
  dropFriendFromCall(): void {
    this.friendInRoom = false
    this.friendJoinedThisCall = false
    this.callHealth = 'connecting'
    this.clearRemoteStreams()
    this.remoteStreamIds = emptyStreamIds()
    this.sendSignal('hangup', { inRoom: this.inCall }).catch(() => {})
    this.resetPeerConnection()
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  handleConnectionFailure(immediate = false): void {
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
    console.log(`[WebRTC] Executando reconexão automática P2P com ${this.friend}...`)

    try {
      // O offerer envia ofertas de ICE restart; o outro pede a oferta primeiro.
      if (!this.isOfferer && this.iceRestartAttempts === 0) {
        await this.sendSignal('reconnect-request', { inRoom: true })
        // Aguarda 4 segundos pela resposta; se não houver, escalona para rebuild
        await new Promise((resolve) => setTimeout(resolve, 4000))
        if (this.peerConnection?.iceConnectionState === 'connected') {
          return
        }
      }

      const pc = this.peerConnection
      if (
        this.iceRestartAttempts < 3 &&
        pc &&
        pc.signalingState !== 'closed' &&
        pc.connectionState !== 'closed'
      ) {
        this.iceRestartAttempts++
        const backoffMs = Math.min(1000 * Math.pow(2, this.iceRestartAttempts - 1), 4000)
        console.log(`[WebRTC] Tentativa ${this.iceRestartAttempts}/3 de ICE Restart com backoff ${backoffMs}ms...`)
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }

        await this.queueNegotiation(() =>
          this.createAndSendOffer(
            pc,
            'renegotiate-offer',
            () => ({ inRoom: this.inCall, isIceRestart: true }),
            { iceRestart: true, offerToReceiveAudio: true, offerToReceiveVideo: true }
          )
        )
      } else if (this.fullReconnectAttempts < 2 && this.inCall) {
        // Reconstrução interna que NÃO zera os contadores de escalonamento
        this.fullReconnectAttempts++
        console.log(`[WebRTC] ICE Restart esgotado. Tentativa ${this.fullReconnectAttempts}/2 de reconstrução completa...`)
        await this.rebuildCall()
      } else if (this.inCall) {
        console.warn('[WebRTC] Todas as tentativas de reconexão esgotadas.')
        this.host.onLinkCallDead(this, 'Não foi possível restabelecer a conexão P2P após várias tentativas.')
      }
    } catch (err) {
      console.warn('[WebRTC] Falha na reconexão automática:', err)
      if (this.fullReconnectAttempts < 2 && this.inCall) {
        this.fullReconnectAttempts++
        await this.rebuildCall().catch(() => {})
      } else if (this.inCall) {
        this.host.onLinkCallDead(this, 'Falha crítica ao restabelecer a conexão P2P.')
      }
    } finally {
      this.isReconnecting = false
    }
  }

  // Reconstrução interna do PeerConnection preservando contadores de escalonamento
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

    if (this.isOfferer) {
      await this.queueNegotiation(() =>
        this.createAndSendOffer(
          pc,
          'sdp-offer',
          () => ({ isMediaCall: true, inRoom: true }),
          { offerToReceiveAudio: true, offerToReceiveVideo: true },
          () => this.broadcastStreamMeta()
        )
      )
    } else {
      await this.sendSignal('room-sync-request', { inRoom: true })
    }
  }

  resetPeerConnection(): void {
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
    for (const release of [...this.stableWaiters]) release()
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

  broadcastStreamMeta(): void {
    this.sendDataChannelPacket({
      type: 'stream-meta',
      sender: this.myUser,
      ...this.host.getLocalStreamIds()
    })
  }

  // ==========================================================================
  // SINAIS WEBRTC RECEBIDOS DESTE AMIGO
  // ==========================================================================
  async handleIncomingSignal(type: string, data: Record<string, unknown>): Promise<void> {
    this.lastFriendSignalReceived = Date.now()

    if (data.streamIds) {
      this.remoteStreamIds = data.streamIds as RemoteStreamIds
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
      if (!data.active) {
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
      if (this.isOfferer) {
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
        console.log(`[WebRTC] Oferta de ${this.friend} para uma PeerConnection antiga: solicitando conexão nova...`)
        this.requestFreshNegotiation()
        return
      }

      // O amigo recriou a PeerConnection dele (ex: saiu da sala, reconstrução após queda).
      // Aplicar a oferta nova na conexão antiga falha ("order of m-lines doesn't match").
      if (
        senderPcId &&
        this.peerConnection &&
        this.remotePcId !== senderPcId &&
        (this.remotePcId !== null || this.peerConnection.remoteDescription)
      ) {
        console.log(`[WebRTC] ${this.friend} recriou a PeerConnection: descartando a conexão antiga.`)
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
        await this.host.acquireMicAndCam(Boolean(this.host.localCamStream)).catch(() => {})
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
        streamIds: this.host.getLocalStreamIds()
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
      const pc = this.peerConnection
      if (pc && (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-pranswer')) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp))
        if (senderPcId) {
          this.remotePcId = senderPcId
        }
        await this.flushPendingIceCandidates(pc)
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
      const pc = this.peerConnection
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
      } else {
        this.pendingIceCandidates.push({ candidate, pcId: senderPcId })
      }
      return
    }

    if (type === 'reconnect-request') {
      if (this.isOfferer) {
        if (senderPcId && senderPcId !== this.remotePcId) {
          // O amigo já está com outra PeerConnection: ICE restart na antiga não adianta
          this.handleRoomSyncRequest(senderPcId)
        } else {
          this.triggerAutoReconnect().catch(() => {})
        }
      }
      return
    }

    if (type === 'p2p-heartbeat') {
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
      console.log(`[WebRTC] Sinal de hangup recebido de ${this.friend}.`)
      this.friendInRoom = Boolean(data.inRoom)
      this.friendJoinedThisCall = false
      this.clearRemoteStreams()
      this.remoteStreamIds = emptyStreamIds()
      // Quem sai da sala fecha a própria PeerConnection. Se era a que estava pareada com a minha,
      // a minha virou um "zumbi" (o DataChannel ainda aparece 'open' por alguns segundos e as
      // mensagens enviadas nele se perdiam). Descarta e, sendo o offerer, renegocia do zero.
      const pairedPcClosed = !senderPcId || senderPcId === this.remotePcId
      if (this.peerConnection && pairedPcClosed) {
        this.resetPeerConnection()
        if (this.isOfferer) {
          const reconnect = this.inCall ? this.rebuildCall() : this.connectDataChannelOnly()
          reconnect.catch(() => {})
        }
      } else if (
        !this.inCall &&
        this.isOfferer &&
        (!this.dataChannel || this.dataChannel.readyState !== 'open')
      ) {
        this.connectDataChannelOnly().catch(() => {})
      }
      this.emitStreamsUpdated()
      this.emitCallState()
    }
  }

  /**
   * (Offerer) O amigo pediu uma oferta: se a PeerConnection dele é a que está pareada com a minha,
   * basta renegociar; se ele está com uma conexão nova (ou nenhuma), recria a minha do zero.
   */
  private handleRoomSyncRequest(requesterPcId: string | null): void {
    const pc = this.peerConnection
    const pairedWithRequester =
      pc !== null &&
      pc.signalingState !== 'closed' &&
      requesterPcId !== null &&
      this.remotePcId === requesterPcId

    // Já existe uma oferta inicial aguardando resposta: a conexão nova do amigo pode aceitá-la,
    // então só reenvia em vez de recriar tudo (evita uma cascata de reconstruções).
    if (pc && pc.signalingState === 'have-local-offer' && this.remotePcId === null && pc.localDescription) {
      this.sendSignal('sdp-offer', {
        sdp: pc.localDescription,
        isMediaCall: this.inCall || this.friendInRoom,
        inRoom: this.inCall,
        streamIds: this.host.getLocalStreamIds()
      }).catch(() => {})
      return
    }

    // Conexão recém-criada cuja oferta inicial ainda está na fila: recriar agora descartaria essa
    // oferta antes de ela sair (com pedidos repetidos, nenhuma oferta chegava a ser enviada).
    if (
      pc &&
      pc.signalingState === 'stable' &&
      this.remotePcId === null &&
      !pc.remoteDescription &&
      Date.now() - this.pcCreatedAt < 8000
    ) {
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

    // Estou no chat: conecta em modo de recepção para exibir a webcam do amigo no avatar
    if (!pairedWithRequester) {
      this.resetPeerConnection()
    }
    this.connectReceiveOnlyCall().catch(() => {})
  }

  /** Recebi uma renegociação destinada a uma PeerConnection que eu já descartei. */
  private requestFreshNegotiation(): void {
    if (this.isOfferer) {
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
  // VOZ DESTE AMIGO NO WEB AUDIO (VAD + BOOST)
  // ==========================================================================
  private setupRemoteVoiceAnalyser(stream: MediaStream): void {
    try {
      const ctx = this.host.ensureAudioContext()
      this.disposeRemoteVoiceNodes()

      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      const gainNode = ctx.createGain()

      // O <audio> do amigo no DOM reproduz a voz de 0% a 100%; acima de 100% o elemento é mutado
      // e a voz sai por este GainNode (ver applyRemoteVoiceOutput).
      source.connect(analyser)
      source.connect(gainNode)

      this.remoteVoiceSourceNode = source
      this.remoteVoiceGainNode = gainNode
      this.remoteVoiceBoostConnected = false
      this.remoteAnalyser = analyser
      this.applyRemoteVoiceOutput()
      this.host.startVoiceActivityLoop()
    } catch (err) {
      console.warn('[WebRTC] Falha ao iniciar analyser de voz remota:', err)
    }
  }

  private disposeRemoteVoiceNodes(): void {
    for (const node of [this.remoteVoiceSourceNode, this.remoteVoiceGainNode]) {
      if (!node) continue
      try {
        node.disconnect()
      } catch {}
    }
    this.remoteVoiceSourceNode = null
    this.remoteVoiceGainNode = null
    this.remoteVoiceBoostConnected = false
  }

  applyRemoteVoiceOutput(): void {
    const gainNode = this.remoteVoiceGainNode
    const ctx = this.host.getAudioContext()
    if (!gainNode || !ctx) return

    const volume = this.host.remoteVoiceVolumePercent
    const boostActive = this.inCall && volume > 100
    if (boostActive) {
      gainNode.gain.setTargetAtTime(Math.max(0, Math.min(2, volume / 100)), ctx.currentTime, 0.02)
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

  // ==========================================================================
  // RTCDataChannel P2P
  // ==========================================================================
  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      this.lastFriendP2PHeartbeat = Date.now()
      this.lastFriendSignalReceived = Date.now()
      this.broadcastStreamMeta()
      this.sendDataChannelPacket({
        type: 'subnick-update',
        sender: this.myUser,
        subnick: this.host.mySubnick,
        status: this.host.myStatus
      })
      this.sendDataChannelPacket({
        type: 'room-state',
        sender: this.myUser,
        inRoom: this.inCall
      })
      this.host.callbacks.onDataChannelOpen?.(this.friend)
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

  sendDataChannelPacket(packet: DataChannelPacket): boolean {
    let sent = false
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify(packet))
        sent = true
      } catch (err) {
        console.warn('[DataChannel] Erro ao enviar pacote via RTCDataChannel:', err)
      }
    }

    // Fallback via Supabase Realtime Broadcast (exceto arquivos e heartbeats P2P para não mascarar queda)
    if (!sent && packet.type !== 'file-chunk' && packet.type !== 'heartbeat' && packet.type !== 'heartbeat-ack') {
      return this.host.sendPacketViaRealtime(this.friend, packet)
    }
    return sent
  }

  handleDataChannelPacket(packet: DataChannelPacket): void {
    this.lastFriendSignalReceived = Date.now()
    const callbacks = this.host.callbacks
    switch (packet.type) {
      case 'chat-message':
        callbacks.onChatMessage({
          id: packet.id,
          sender: packet.sender,
          text: packet.text,
          imageDataUrl: packet.imageDataUrl,
          timestamp: packet.timestamp
        })
        break

      case 'chat-history-sync':
        if (Array.isArray(packet.messages)) {
          callbacks.onChatHistorySync?.(this.friend, packet.messages)
        }
        break

      case 'nudge':
        callbacks.onNudgeReceived(packet.sender)
        break

      case 'soundboard-wink':
        callbacks.onSoundboardWink(packet.sender, packet.winkId, packet.label)
        break

      case 'subnick-update':
        this.friendLastStatus = packet.status
        callbacks.onFriendPresenceChange(this.friend, packet.status, packet.subnick, false)
        break

      case 'dj-sync':
        callbacks.onDjSync(packet.state, Boolean(packet.initial))
        break

      case 'album-ranked':
        callbacks.onAlbumRankedNotification({
          user: packet.user,
          albumId: packet.albumId,
          albumName: packet.albumName,
          artistName: packet.artistName,
          rating: packet.rating
        })
        break

      case 'heartbeat':
        this.lastFriendP2PHeartbeat = Date.now()
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
        this.friendJoinedThisCall = true
        if (this.peerConnection?.iceConnectionState === 'connected' && this.inCall) {
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
          this.clearRemoteStreams()
          this.emitStreamsUpdated()
          console.log(`[WebRTC] ${this.friend} saiu da sala via room-state.`)
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
        callbacks.onFileProgress({ fileName: packet.fileName, percent: 0, direction: 'receiving' })
        break

      case 'file-chunk': {
        const transfer = this.incomingFiles.get(packet.transferId)
        if (!transfer) break
        if (packet.chunkIndex < 0 || packet.chunkIndex >= transfer.totalChunks) break
        if (transfer.chunks[packet.chunkIndex] !== undefined) break
        // Cada chunk é decodificado isoladamente (o tamanho é múltiplo de 4 em base64)
        transfer.chunks[packet.chunkIndex] = base64ToBytes(packet.dataBase64)
        const prevPercent = Math.round((transfer.receivedCount / transfer.totalChunks) * 100)
        transfer.receivedCount += 1
        const percent = Math.round((transfer.receivedCount / transfer.totalChunks) * 100)
        if (percent !== prevPercent) {
          callbacks.onFileProgress({ fileName: transfer.fileName, percent, direction: 'receiving' })
        }
        break
      }

      case 'file-end': {
        const transfer = this.incomingFiles.get(packet.transferId)
        if (!transfer) break
        this.incomingFiles.delete(packet.transferId)
        callbacks.onFileProgress(null)

        const timestamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        const complete =
          !packet.aborted &&
          transfer.receivedCount === transfer.totalChunks &&
          transfer.chunks.every((c) => c !== undefined)
        if (!complete) {
          callbacks.onChatMessage({
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
        callbacks.onChatMessage({
          id: `file-${packet.transferId}`,
          sender: transfer.sender,
          text: `📁 Enviou um arquivo P2P: ${transfer.fileName}`,
          fileAttachment: {
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            mimeType: transfer.mimeType,
            blobUrl: URL.createObjectURL(blob)
          },
          timestamp
        })
        break
      }
    }
  }

  sendChatHistorySync(messages: ChatMessageItem[]): void {
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
      this.sendDataChannelPacket({ type: 'chat-history-sync', sender: this.myUser, messages: batch })
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

  // ==========================================================================
  // ARQUIVOS P2P
  // ==========================================================================

  /** Aguarda um DataChannel aberto, solicitando a conexão P2P se necessário. */
  private async waitForOpenDataChannel(timeoutMs: number): Promise<RTCDataChannel | null> {
    if (this.dataChannel?.readyState === 'open') return this.dataChannel

    if (this.isOfferer) {
      if (!this.inCall) this.ensureChatDataChannel()
    } else {
      this.sendSignal('room-sync-request', { inRoom: this.inCall }).catch(() => {})
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.host.isDestroyed) {
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

  /**
   * Envia um arquivo P2P em chunks de 36 KB (48 KB em base64) com controle real de backpressure.
   */
  async sendFile(file: File, transferId: string): Promise<void> {
    const channel = await this.waitForOpenDataChannel(12000)
    if (!channel) {
      throw new Error(`Conexão P2P com ${this.friend} indisponível no momento.`)
    }

    // Múltiplo de 3 bytes: cada chunk vira base64 sem padding e pode ser decodificado isoladamente
    const rawChunkSize = 36 * 1024
    const totalChunks = Math.max(1, Math.ceil(file.size / rawChunkSize))
    const callbacks = this.host.callbacks

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
          dataBase64: bytesToBase64(new Uint8Array(buffer))
        })

        const percent = Math.round(((idx + 1) / totalChunks) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          callbacks.onFileProgress({ fileName: file.name, percent, direction: 'sending' })
        }
      }

      await this.sendWithBackpressure(channel, { type: 'file-end', transferId })
    } catch (err) {
      try {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'file-end', transferId, aborted: true }))
        }
      } catch {}
      throw err
    } finally {
      callbacks.onFileProgress(null)
    }
  }

  // ==========================================================================
  // LIMPEZA
  // ==========================================================================

  /** Logout / fechar o app: avisa o amigo se eu estava na sala e libera tudo. */
  destroy(): void {
    if (this.offlineGraceTimeout) clearTimeout(this.offlineGraceTimeout)
    if (this.disconnectGraceTimer) clearTimeout(this.disconnectGraceTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer)
    this.stopCallHealthTimers()
    this.disposeRemoteVoiceNodes()
    this.remoteAnalyser = null
    this.clearRemoteStreams()
    this.resetPeerConnection()
  }

  /** Avisa o amigo que saí da sala (usado no logout/fechar o app durante a ligação). */
  notifyLeftRoom(): void {
    this.sendDataChannelPacket({ type: 'room-state', sender: this.myUser, inRoom: false })
    this.sendSignal('hangup', { inRoom: false }).catch(() => {})
  }

  get hasLiveRemoteMedia(): boolean {
    return Boolean(
      (this.remoteCamStream && this.remoteCamStream.getVideoTracks().some((t) => t.readyState === 'live')) ||
        (this.remoteVoiceStream && this.remoteVoiceStream.getAudioTracks().some((t) => t.readyState === 'live'))
    )
  }

  get isRemoteScreenSharing(): boolean {
    return Boolean(
      this.remoteScreenStream &&
        this.remoteScreenStream.getVideoTracks().length > 0 &&
        this.remoteStreamIds.screenStreamId
    )
  }
}

// ==========================================================================
// SDP MUNGING: CODEC H.264 HARDWARE (NVENC/AMF/QUICKSYNC) + 10MBPS + OPUS 510KBPS STEREO
// ==========================================================================
export function mungeSdpForHardwareH264AndOpus(sdp: string): string {
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
