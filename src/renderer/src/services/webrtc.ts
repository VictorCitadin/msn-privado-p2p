import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { SoundboardWinkId } from './soundManager'
import { PeerLink, PresenceEntry } from './peerLink'
import { ScreenAudioCapture } from './screenAudio'
import {
  ALL_USERS,
  CallHealth,
  ChatMessageItem,
  DataChannelPacket,
  DjSyncState,
  MsnUser,
  PresenceStatus,
  RemotePeerStreams,
  WebRTCCallbacks
} from './types'

export * from './types'

/**
 * Serviço P2P WebRTC — malha (mesh) entre Vitinho, Will e Nath.
 * - Um PeerLink (RTCPeerConnection + DataChannel) por amigo; com só Vitinho e Will online,
 *   existe uma única conexão ativa e tudo funciona exatamente como na versão 1.x.
 * - Mídia local (mic/câmera/tela), canal Supabase Realtime (presença + sinalização) e Web Audio
 *   são compartilhados entre os links.
 * - Codec H.264 hardware + Opus 510 kbps (SDP munging), boost de voz até 200% e auto-ducking do DJ Bot.
 */
export class MsnWebRTCService {
  readonly myUser: MsnUser
  readonly callbacks: WebRTCCallbacks
  readonly links: Map<MsnUser, PeerLink> = new Map()

  private supabase: SupabaseClient | null = null
  private realtimeChannel: RealtimeChannel | null = null
  private realtimeReconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private realtimeBackoffMs = 2000
  // Geração do canal Realtime: callbacks de canais antigos (ex: CLOSED ao remover) são ignorados
  private realtimeGeneration = 0
  private realtimeSubscribedAt = 0
  private presenceHeartbeatInterval: ReturnType<typeof setInterval> | null = null
  private presenceSweepInterval: ReturnType<typeof setInterval> | null = null
  private instanceId = `${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
  private protocolVersion = 3

  // Estado compartilhado lido pelos PeerLinks
  inCall = false
  isDestroyed = false
  mySubnick = ''
  myStatus: PresenceStatus = 'online'
  localMicStream: MediaStream | null = null
  localCamStream: MediaStream | null = null
  localScreenStream: MediaStream | null = null
  remoteVoiceVolumePercent = 100

  private ecoMode = false
  private preferredAudioDeviceId = ''
  private preferredVideoDeviceId = ''

  // Web Audio API (VAD local, boost de voz, captura de áudio da tela)
  private audioCtx: AudioContext | null = null
  private localVoiceSourceNode: MediaStreamAudioSourceNode | null = null
  private localAnalyser: AnalyserNode | null = null
  private vadInterval: ReturnType<typeof setInterval> | null = null
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null
  private currentlySpeaking = false
  private djBotPlaying = false
  private rawScreenStream: MediaStream | null = null
  private screenAudio: ScreenAudioCapture

  private lastFriendsInRoomCount = -1
  private visibilityHandler: (() => void) | null = null
  private onlineHandler: (() => void) | null = null

  constructor(myUser: MsnUser, callbacks: WebRTCCallbacks) {
    this.myUser = myUser
    this.callbacks = callbacks
    for (const friend of ALL_USERS) {
      if (friend !== myUser) {
        this.links.set(friend, new PeerLink(this, friend))
      }
    }
    this.screenAudio = new ScreenAudioCapture(
      () => this.ensureAudioContext(),
      () => this.allLinks().flatMap((l) => (l.remoteVoiceStream ? [l.remoteVoiceStream] : []))
    )
    this.initSignaling()
    this.setupOnlineListener()
  }

  private allLinks(): PeerLink[] {
    return [...this.links.values()]
  }

  getLink(friend: MsnUser): PeerLink | undefined {
    return this.links.get(friend)
  }

  private setupOnlineListener(): void {
    this.onlineHandler = () => {
      console.log('[WebRTC] Conexão com a rede reestabelecida. Sincronizando presença e verificando P2P...')
      if (this.supabase && !this.isDestroyed) {
        this.setupRealtimeChannel()
      }
      this.trackPresenceState()
      for (const link of this.allLinks()) {
        if (this.inCall || link.friendInRoom) {
          link.handleConnectionFailure()
        }
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
  // 1. SERVIDORES ICE (STUN GOOGLE/CLOUDFLARE + TURN .ENV)
  // ==========================================================================
  getIceServers(): RTCIceServer[] {
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
  // 2. SINALIZAÇÃO E PRESENÇA (SUPABASE REALTIME)
  // ==========================================================================
  private initSignaling(): void {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey)
      this.setupRealtimeChannel()

      // Heartbeat contínuo de presença a cada 8 segundos (impede que os amigos me vejam offline)
      this.presenceHeartbeatInterval = setInterval(() => {
        if (!this.isDestroyed) this.trackPresenceState()
      }, 8000)

      // Varredura a cada 4 segundos combinando Presença Realtime + Heartbeat P2P + Sinais
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
        for (const link of this.allLinks()) {
          link.handlePresenceSync((state[link.friend] as PresenceEntry[]) || [])
        }
      })
      .on('broadcast', { event: 'webrtc-signal' }, async ({ payload }) => {
        if (!isCurrent() || !payload || payload.target !== this.myUser) return
        const link = this.links.get(payload.sender as MsnUser)
        if (!link) return
        try {
          await link.handleIncomingSignal(payload.type, payload.data || {})
        } catch (err) {
          console.warn(`[WebRTC] Erro ao processar sinal "${payload.type}" de ${payload.sender}:`, err)
        }
      })
      .on('broadcast', { event: 'msn-packet' }, ({ payload }) => {
        if (!isCurrent() || !payload || payload.target !== this.myUser) return
        const link = this.links.get(payload.sender as MsnUser)
        if (!link) return
        link.handleDataChannelPacket(payload.packet)
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
    // Enquanto o canal Realtime está sendo recriado (ou acabou de entrar e ainda não recebeu o
    // primeiro sync), a lista de presença vazia não significa que o amigo saiu.
    const presenceUncertain =
      !this.realtimeChannel || Date.now() - this.realtimeSubscribedAt < 10000
    const state = presenceUncertain ? null : this.realtimeChannel?.presenceState() || {}
    for (const link of this.allLinks()) {
      link.sweepPresence(state ? ((state[link.friend] as unknown[]) || []) : null)
    }
  }

  async sendSignalTo(friend: MsnUser, type: string, data: Record<string, unknown>): Promise<void> {
    // Envio com latência mínima via WebSocket do Supabase Realtime Broadcast
    if (!this.realtimeChannel) return
    try {
      await this.realtimeChannel.send({
        type: 'broadcast',
        event: 'webrtc-signal',
        payload: { sender: this.myUser, target: friend, type, data }
      })
    } catch (err) {
      console.warn('[WebRTC] Falha ao enviar sinal Realtime Broadcast:', err)
    }
  }

  sendPacketViaRealtime(friend: MsnUser, packet: DataChannelPacket): boolean {
    if (!this.realtimeChannel) return false
    this.realtimeChannel
      .send({
        type: 'broadcast',
        event: 'msn-packet',
        payload: { sender: this.myUser, target: friend, packet }
      })
      .catch(() => {})
    return true
  }

  trackPresenceState(): void {
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

  // ==========================================================================
  // 3. MÍDIA LOCAL (MICROFONE / WEBCAM)
  // ==========================================================================
  async acquireMicAndCam(withVideo: boolean): Promise<void> {
    // 1. Microfone em MediaStream exclusivo (com suporte a dispositivo escolhido pelo usuário)
    if (!this.localMicStream) {
      try {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(this.preferredAudioDeviceId ? { deviceId: { exact: this.preferredAudioDeviceId } } : {})
        }
        try {
          this.localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false
          })
        } catch {
          this.localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
          })
        }
        this.setupLocalVoiceAnalyser(this.localMicStream)
      } catch (err) {
        console.warn('[WebRTC] Microfone indisponível ou em uso, seguindo chamada:', err)
      }
    }

    // 2. Webcam em MediaStream separado em resolução natural 1280x720@30fps
    if (withVideo && !this.localCamStream) {
      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          ...(this.preferredVideoDeviceId ? { deviceId: { exact: this.preferredVideoDeviceId } } : {})
        }
        try {
          this.localCamStream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false
          })
        } catch {
          this.localCamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
            audio: false
          })
        }
      } catch (err) {
        console.warn('[WebRTC] Webcam indisponível ou em uso, seguindo chamada apenas com áudio/recepção:', err)
      }
    }
  }

  async setPreferredDevices(audioDeviceId: string, videoDeviceId: string): Promise<void> {
    const audioChanged = audioDeviceId !== this.preferredAudioDeviceId
    const videoChanged = videoDeviceId !== this.preferredVideoDeviceId
    this.preferredAudioDeviceId = audioDeviceId
    this.preferredVideoDeviceId = videoDeviceId

    if (!this.inCall) return

    const wasMuted = this.isMicrophoneMuted()
    const wasCamEnabled = this.localCamStream?.getVideoTracks()[0]?.enabled ?? true

    if (audioChanged) {
      try {
        const newMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(audioDeviceId && audioDeviceId !== 'default' ? { deviceId: { exact: audioDeviceId } } : {})
          },
          video: false
        })
        const newAudioTrack = newMicStream.getAudioTracks()[0]
        if (newAudioTrack) {
          newAudioTrack.enabled = !wasMuted
          const oldAudioTrack = this.localMicStream?.getAudioTracks()[0]
          for (const link of this.allLinks()) {
            await link.replaceLocalTrack('audio', oldAudioTrack, newAudioTrack, newMicStream)
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
            ...(videoDeviceId && videoDeviceId !== 'default' ? { deviceId: { exact: videoDeviceId } } : {})
          },
          audio: false
        })
        const newVideoTrack = newCamStream.getVideoTracks()[0]
        if (newVideoTrack) {
          newVideoTrack.enabled = wasCamEnabled
          const oldVideoTrack = this.localCamStream?.getVideoTracks()[0]
          for (const link of this.allLinks()) {
            await link.replaceLocalTrack('video', oldVideoTrack, newVideoTrack, newCamStream)
          }
          this.localCamStream?.getTracks().forEach((t) => t.stop())
          this.localCamStream = newCamStream
        }
      } catch (err) {
        console.warn('[WebRTC] Erro ao trocar webcam ao vivo:', err)
      }
    }

    this.allLinks().forEach((l) => l.broadcastStreamMeta())
    this.emitStreamsUpdated()
  }

  getLocalStreamIds(): { micStreamId: string | null; camStreamId: string | null; screenStreamId: string | null } {
    return {
      micStreamId: this.localMicStream?.id || null,
      camStreamId: this.localCamStream?.id || null,
      screenStreamId: this.localScreenStream?.id || null
    }
  }

  // ==========================================================================
  // 4. SALA (LIGAÇÃO EM GRUPO)
  // ==========================================================================
  async startCall(withVideo = true): Promise<void> {
    this.inCall = true
    this.emitCallState()

    await this.acquireMicAndCam(withVideo)
    this.trackPresenceState()
    this.emitStreamsUpdated()

    await Promise.all(this.allLinks().map((link) => link.onLocalJoinRoom().catch(() => {})))
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  async acceptIncomingCall(): Promise<void> {
    await this.startCall(true)
  }

  rejectOrHangupCall(): void {
    this.inCall = false
    this.cleanupLocalMediaStreams()
    for (const link of this.allLinks()) {
      link.onLocalLeaveRoom()
    }
    this.trackPresenceState()
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  /**
   * Um link detectou que o amigo caiu. Se ainda há outro amigo comigo na sala, só aquele amigo
   * sai da ligação; se era o único, eu saio da sala como antes (onCallDropped).
   */
  onLinkCallDead(deadLink: PeerLink, reason: string): void {
    if (!this.inCall) return
    const othersInRoom = this.allLinks().some(
      (l) => l !== deadLink && l.friendInRoom && l.peerConnection?.connectionState === 'connected'
    )
    if (othersInRoom) {
      console.warn(`[WebRTC] ${deadLink.friend} caiu da ligação; continuo na sala com os outros.`)
      deadLink.dropFriendFromCall()
      this.callbacks.onFriendDroppedFromCall?.(deadLink.friend, reason)
      return
    }

    console.warn(`[WebRTC] Chamada encerrada por queda/falha: ${reason}`)
    this.inCall = false
    this.cleanupLocalMediaStreams()
    for (const link of this.allLinks()) {
      link.onLocalLeaveRoom()
    }
    this.trackPresenceState()
    this.emitStreamsUpdated()
    this.emitCallState()
    this.callbacks.onCallDropped?.(reason)
  }

  /**
   * Compartilhamento de Tela / Janela (Modo Cinema), enviado para todos na sala.
   * - Vídeo 60fps com contentHint = 'motion' e até 10 Mbps
   * - Áudio do sistema sem a voz dos amigos (captura nativa por processo ou cancelador AudioWorklet)
   */
  async startScreenShare(sourceId: string, includeSystemAudio: boolean): Promise<void> {
    if (!this.inCall) {
      await this.startCall(true)
    }
    // Trocar de janela/tela: encerra a transmissão anterior para não deixar a captura antiga rodando
    if (this.localScreenStream) {
      await this.stopScreenShare()
    }

    const constraints: MediaStreamConstraints = {
      audio: includeSystemAudio
        ? ({
            mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
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
    this.cleanupScreenAudio()
    this.rawScreenStream = rawDesktopStream

    const screenVideoTrack = rawDesktopStream.getVideoTracks()[0]
    if (screenVideoTrack) {
      screenVideoTrack.contentHint = 'motion'
      screenVideoTrack.onended = () => {
        this.stopScreenShare()
      }
    }

    const finalScreenStream = new MediaStream()
    if (screenVideoTrack) {
      finalScreenStream.addTrack(screenVideoTrack)
    }

    const rawScreenAudioTrack = rawDesktopStream.getAudioTracks()[0]
    if (includeSystemAudio) {
      const isWindow = sourceId.startsWith('window:')
      let windowHwnd: number | undefined
      if (isWindow) {
        const raw = (sourceId.split(':')[1] || '').trim()
        const parsed = raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10)
        if (!isNaN(parsed) && parsed !== 0) {
          windowHwnd = parsed >>> 0
        }
      }

      const loopbackOptions =
        isWindow && windowHwnd ? { mode: 'include' as const, hwnd: windowHwnd } : { mode: 'exclude' as const }

      console.log('[WebRTC] Iniciando áudio do compartilhamento estilo Discord:', loopbackOptions)
      const excludedAudioTrack = await this.screenAudio.createExcludedLoopbackAudioTrack(loopbackOptions)
      if (excludedAudioTrack) {
        finalScreenStream.addTrack(excludedAudioTrack)
      } else if (rawScreenAudioTrack) {
        // Fallback: cancelador AudioWorklet que subtrai a voz dos amigos.
        // NUNCA envia a trilha bruta sem cancelamento para o amigo não se ouvir!
        console.warn('[WebRTC] Captura nativa falhou; usando cancelador adaptativo AudioWorklet.')
        const cancelledTrack = await this.screenAudio.createWorkletCancelledAudioTrack(rawScreenAudioTrack)
        if (cancelledTrack) {
          finalScreenStream.addTrack(cancelledTrack)
        } else {
          console.warn('[WebRTC] Sem cancelador disponível; desativando áudio do compartilhamento para proteger contra eco.')
        }
      }
    }

    this.localScreenStream = finalScreenStream
    this.updateScreenAudioLoopbackGate()
    await this.applyCameraConstraints()

    await Promise.all(this.allLinks().map((link) => link.startScreenShare(finalScreenStream).catch(() => {})))
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  async stopScreenShare(): Promise<void> {
    if (!this.localScreenStream) return
    const screenTracks = this.localScreenStream.getTracks()

    for (const link of this.allLinks()) {
      await link.stopScreenShare(screenTracks)
    }

    this.localScreenStream.getTracks().forEach((t) => t.stop())
    this.localScreenStream = null
    this.cleanupScreenAudio()

    if (!this.ecoMode) {
      await this.applyCameraConstraints()
    }

    for (const link of this.allLinks()) {
      link.broadcastStreamMeta()
      await link.renegotiatePeerConnection().catch(() => {})
    }
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  /**
   * Mantém a câmera sempre em resolução nativa fluida (1280x720 @ 30fps) sem zoom e sem travar,
   * tanto no Modo Jogo OFF quanto no Modo Jogo ON.
   */
  async setEcoMode(enabled: boolean): Promise<void> {
    this.ecoMode = enabled
    await this.applyCameraConstraints()
  }

  private async applyCameraConstraints(): Promise<void> {
    const camTrack = this.localCamStream?.getVideoTracks()[0]
    if (!camTrack) return
    try {
      await camTrack.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } })
    } catch (err) {
      console.warn('[WebRTC] Falha ao aplicar constraints na câmera:', err)
    }
  }

  toggleMicrophoneMute(): boolean {
    const audioTrack = this.localMicStream?.getAudioTracks()[0]
    if (!audioTrack) return false
    audioTrack.enabled = !audioTrack.enabled
    return !audioTrack.enabled // retorna true se ficou mutado
  }

  isMicrophoneMuted(): boolean {
    const audioTrack = this.localMicStream?.getAudioTracks()[0]
    return audioTrack ? !audioTrack.enabled : false
  }

  async toggleCameraEnabled(): Promise<boolean> {
    if (!this.localCamStream) {
      await this.acquireMicAndCam(true)
      const currentCamStream = this.localCamStream as MediaStream | null
      if (currentCamStream) {
        for (const link of this.allLinks()) {
          const pc = link.peerConnection
          if (!pc) continue
          link.attachLocalStreamsToPeer(pc)
          await link.ensureTransceiversSendRecv(pc)
          await link.renegotiatePeerConnection().catch(() => {})
        }
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

  /** Lista as câmeras disponíveis e troca para a próxima (tablet: frontal ↔ traseira). */
  async switchToNextCamera(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId)
    if (cams.length < 2) return
    const currentId =
      this.localCamStream?.getVideoTracks()[0]?.getSettings().deviceId || this.preferredVideoDeviceId
    const idx = cams.findIndex((c) => c.deviceId === currentId)
    const next = cams[(idx + 1) % cams.length]
    await this.setPreferredDevices(this.preferredAudioDeviceId, next.deviceId)
  }

  // ==========================================================================
  // 5. WEB AUDIO: VAD, BOOST DE VOZ E ÁUDIO DA TELA
  // ==========================================================================
  ensureAudioContext(): AudioContext {
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

  getAudioContext(): AudioContext | null {
    return this.audioCtx
  }

  resumeAudioContext(): void {
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

  /**
   * Indica se a voz dos amigos está saindo pelo Web Audio (boost > 100%). Nesse caso os
   * elementos <audio> de voz devem ficar mutados para não tocar a voz em dobro.
   */
  static isVoiceBoostVolume(volumePercent: number): boolean {
    return volumePercent > 100
  }

  /**
   * Volume da voz dos amigos (0% a 200%). Até 100% o volume é aplicado nos elementos <audio>;
   * acima disso a voz é roteada pelo GainNode de cada amigo.
   */
  setRemoteVoiceBoostVolume(volumePercent: number): void {
    this.remoteVoiceVolumePercent = volumePercent
    this.resumeAudioContext()
    this.allLinks().forEach((l) => l.applyRemoteVoiceOutput())
  }

  /**
   * Informa se o DJ Bot está tocando: o áudio do compartilhamento de tela é silenciado na origem
   * para nunca transmitir uma 2ª cópia atrasada da música para os amigos.
   */
  setDjBotPlayingState(isPlaying: boolean): void {
    this.djBotPlaying = isPlaying
    this.updateScreenAudioLoopbackGate()
  }

  private updateScreenAudioLoopbackGate(): void {
    const screenAudioTrack = this.localScreenStream?.getAudioTracks()[0]
    if (!screenAudioTrack) return
    screenAudioTrack.enabled = !this.djBotPlaying
  }

  /** Loop (60ms) de detecção de voz para o Auto-Ducking do DJ Bot */
  startVoiceActivityLoop(): void {
    if (this.vadInterval) return
    const buffer = new Uint8Array(64)

    const computeLevel = (analyser: AnalyserNode | null): number => {
      if (!analyser) return 0
      analyser.getByteFrequencyData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i]
      }
      return sum / buffer.length
    }

    this.vadInterval = setInterval(() => {
      const localLevel = !this.isMicrophoneMuted() ? computeLevel(this.localAnalyser) : 0
      const remoteLevel = Math.max(0, ...this.allLinks().map((l) => computeLevel(l.remoteAnalyser)))
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

  private cleanupScreenAudio(): void {
    this.screenAudio.cleanup()
    if (this.rawScreenStream) {
      this.rawScreenStream.getTracks().forEach((t) => t.stop())
      this.rawScreenStream = null
    }
  }

  // ==========================================================================
  // 6. MENSAGENS EM GRUPO (CHAT, NUDGE, WINKS, DJ BOT, RANKINGS, ARQUIVOS)
  // ==========================================================================
  private broadcastPacket(packet: DataChannelPacket): void {
    // Amigo offline não está inscrito no canal Realtime, então simplesmente não recebe: a Nath não
    // vê o que foi dito enquanto ela estava offline (e Vitinho↔Will continua igual à versão 1.x)
    for (const link of this.allLinks()) {
      link.sendDataChannelPacket(packet)
    }
  }

  sendChatMessage(text?: string, imageDataUrl?: string): ChatMessageItem {
    const msg: ChatMessageItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender: this.myUser,
      text,
      imageDataUrl,
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    }
    this.broadcastPacket({
      type: 'chat-message',
      id: msg.id,
      sender: msg.sender,
      text: msg.text,
      imageDataUrl: msg.imageDataUrl,
      timestamp: msg.timestamp
    })
    return msg
  }

  sendChatHistorySync(friend: MsnUser, messages: ChatMessageItem[]): void {
    this.links.get(friend)?.sendChatHistorySync(messages)
  }

  /**
   * Envia um arquivo para todos os amigos online. Retorna a mensagem local se ao menos um
   * recebeu; lança erro se nenhum envio deu certo.
   */
  async sendFileP2P(file: File): Promise<ChatMessageItem> {
    const targets = this.allLinks().filter((l) => l.isFriendOnline || l.dataChannel?.readyState === 'open')
    if (targets.length === 0) {
      throw new Error('Nenhum amigo online para receber o arquivo.')
    }
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const errors: string[] = []
    let delivered = 0
    for (const link of targets) {
      try {
        await link.sendFile(file, transferId)
        delivered++
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    if (delivered === 0) {
      throw new Error(errors[0] || 'Conexão P2P indisponível no momento.')
    }
    return {
      id: `file-${transferId}`,
      sender: this.myUser,
      text: `📁 Arquivo enviado: ${file.name}`,
      fileAttachment: {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        blobUrl: URL.createObjectURL(file)
      },
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    }
  }

  sendNudge(): void {
    this.broadcastPacket({ type: 'nudge', sender: this.myUser, timestamp: new Date().toISOString() })
  }

  sendSoundboardWink(winkId: SoundboardWinkId, label: string): void {
    this.broadcastPacket({ type: 'soundboard-wink', sender: this.myUser, winkId, label })
  }

  sendSubnickAndStatus(subnick: string, status: PresenceStatus): void {
    this.mySubnick = subnick
    this.myStatus = status
    this.broadcastPacket({ type: 'subnick-update', sender: this.myUser, subnick, status })
    this.trackPresenceState()
  }

  /** DJ Bot existe só no app de PC (o app do tablet ignora estes pacotes). */
  sendDjSync(state: DjSyncState, initial = false, friend?: MsnUser): void {
    const packet: DataChannelPacket = { type: 'dj-sync', state, initial }
    if (friend) {
      this.links.get(friend)?.sendDataChannelPacket(packet)
      return
    }
    this.broadcastPacket(packet)
  }

  sendAlbumRankedAlert(payload: {
    user: MsnUser
    albumId: string
    albumName: string
    artistName: string
    rating: number
  }): void {
    this.broadcastPacket({ type: 'album-ranked', ...payload })
  }

  // ==========================================================================
  // 7. LIMPEZA E EMISSÃO DE ESTADO
  // ==========================================================================
  private cleanupLocalMediaStreams(): void {
    const localTracks = [
      ...(this.localMicStream?.getTracks() || []),
      ...(this.localCamStream?.getTracks() || []),
      ...(this.localScreenStream?.getTracks() || [])
    ]
    for (const link of this.allLinks()) {
      link.removeLocalTracks(localTracks)
    }
    localTracks.forEach((t) => t.stop())
    this.cleanupScreenAudio()
    this.localMicStream = null
    this.localCamStream = null
    this.localScreenStream = null
  }

  emitStreamsUpdated(): void {
    const remotes: Partial<Record<MsnUser, RemotePeerStreams>> = {}
    for (const link of this.allLinks()) {
      remotes[link.friend] = {
        voice: link.remoteVoiceStream,
        cam: link.remoteCamStream,
        screen: link.remoteScreenStream
      }
    }
    this.callbacks.onStreamsUpdated({
      localCam: this.localCamStream,
      localScreen: this.localScreenStream,
      remotes
    })
  }

  friendsInRoomCount(): number {
    return this.allLinks().filter((l) => l.friendInRoom).length
  }

  emitCallState(): void {
    const links = this.allLinks()
    const friendsInRoom = links
      .filter((l) => l.friendInRoom || l.hasLiveRemoteMedia)
      .map((l) => l.friend)

    // Quantidade de amigos na sala mudou: reajusta o teto de bitrate das câmeras (malha)
    const roomCount = this.friendsInRoomCount()
    if (roomCount !== this.lastFriendsInRoomCount) {
      this.lastFriendsInRoomCount = roomCount
      links.forEach((l) => l.applySenderEncodings().catch(() => {}))
    }
    const sharer = links.find((l) => l.isRemoteScreenSharing)

    // Saúde da ligação = pior estado entre os amigos que estão comigo na sala
    let callHealth: CallHealth = this.inCall ? 'connecting' : 'dead'
    if (this.inCall) {
      const inRoomLinks = links.filter((l) => l.friendInRoom)
      const states = inRoomLinks.map((l) => l.callHealth)
      if (states.includes('recovering')) callHealth = 'recovering'
      else if (states.includes('degraded')) callHealth = 'degraded'
      else if (states.includes('healthy')) callHealth = 'healthy'
    }

    this.callbacks.onCallStateChange({
      inCall: this.inCall,
      friendsInRoom,
      isScreenSharing: Boolean(this.localScreenStream),
      remoteScreenSharer: sharer ? sharer.friend : null,
      callHealth
    })
  }

  destroy(): void {
    // Avisa os amigos que saí da sala (logout/fechar o app durante a ligação)
    if (this.inCall && !this.isDestroyed) {
      this.allLinks().forEach((l) => l.notifyLeftRoom())
      this.inCall = false
    }
    this.isDestroyed = true
    if (this.realtimeReconnectTimeout) {
      clearTimeout(this.realtimeReconnectTimeout)
      this.realtimeReconnectTimeout = null
    }
    if (this.vadInterval) {
      clearInterval(this.vadInterval)
      this.vadInterval = null
    }
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
    if (this.presenceHeartbeatInterval) {
      clearInterval(this.presenceHeartbeatInterval)
      this.presenceHeartbeatInterval = null
    }
    if (this.presenceSweepInterval) {
      clearInterval(this.presenceSweepInterval)
      this.presenceSweepInterval = null
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler)
      this.onlineHandler = null
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    this.cleanupLocalMediaStreams()
    this.allLinks().forEach((l) => l.destroy())
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
      this.screenAudio.resetContext()
    }
  }
}
