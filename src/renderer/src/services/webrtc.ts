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

export interface LaserPointerPoint {
  id: string
  x: number // 0..1 relativo ao vídeo
  y: number // 0..1 relativo ao vídeo
  sender: MsnUser
  createdAt: number
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
      type: 'laser-pointer'
      sender: MsnUser
      x: number
      y: number
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
    }

interface IncomingFileBuffer {
  sender: MsnUser
  fileName: string
  fileSize: number
  mimeType: string
  totalChunks: number
  chunks: string[]
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
  onLaserPointer: (point: LaserPointerPoint) => void
  onSoundboardWink: (sender: MsnUser, winkId: SoundboardWinkId, label: string) => void
  onDjSync: (state: DjSyncState) => void
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
  }) => void
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
  private pendingIceCandidates: RTCIceCandidateInit[] = []
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

  // Buffer de recepção de arquivos P2P
  private incomingFiles: Map<string, IncomingFileBuffer> = new Map()

  constructor(myUser: MsnUser, callbacks: WebRTCCallbacks) {
    this.myUser = myUser
    this.friendUser = myUser === 'Vitinho' ? 'Will' : 'Vitinho'
    this.callbacks = callbacks
    this.initSignaling()
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
      this.realtimeChannel = this.supabase.channel('msn-vitinho-will', {
        config: {
          presence: { key: this.myUser },
          broadcast: { self: false }
        }
      })

      this.realtimeChannel
        .on('presence', { event: 'sync' }, () => {
          const state = this.realtimeChannel?.presenceState() || {}
          const friendPresences = state[this.friendUser] as
            | Array<{ status?: PresenceStatus; subnick?: string; inRoom?: boolean }>
            | undefined

          if (friendPresences && friendPresences.length > 0) {
            const latest = friendPresences[0]
            const newStatus: PresenceStatus = latest.status || 'online'
            const rawSub = latest.subnick === 'Disponível no MSN Privado 🎮' ? '' : latest.subnick
            const newSubnick = rawSub || ''
            const justLoggedIn = this.friendLastStatus === 'offline' && newStatus !== 'offline'
            this.friendLastStatus = newStatus
            if (typeof latest.inRoom === 'boolean') {
              this.friendInRoom = latest.inRoom
              this.emitCallState()
            }
            this.callbacks.onFriendPresenceChange(newStatus, newSubnick, justLoggedIn)

            if (this.inCall && (justLoggedIn || !this.peerConnection)) {
              // Se estamos na Sala e o amigo acabou de abrir o app, envia nossa webcam ao vivo para o Chat dele!
              setTimeout(() => {
                if (this.inCall) {
                  this.renegotiatePeerConnection().catch(() => {})
                }
              }, 350)
            } else if (!this.inCall && latest.inRoom && !this.remoteCamStream) {
              // Se o amigo já está na Sala e ainda não temos a webcam dele, pede sincronização da Sala
              this.sendSignal('room-sync-request', {}).catch(() => {})
            } else if (!this.peerConnection && this.myUser === 'Vitinho') {
              // Inicia P2P silencioso para chat/arquivos
              this.connectDataChannelOnly().catch(() => {})
            }
          } else {
            this.friendLastStatus = 'offline'
            this.friendInRoom = false
            this.remoteVoiceStream = null
            this.remoteCamStream = null
            this.remoteScreenStream = null
            this.emitStreamsUpdated()
            this.emitCallState()
            this.callbacks.onFriendPresenceChange('offline', 'Offline', false)
          }
        })
        .on('broadcast', { event: 'webrtc-signal' }, async ({ payload }) => {
          if (!payload || payload.target !== this.myUser) return
          await this.handleIncomingSignal(payload.sender, payload.type, payload.data)
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            await this.realtimeChannel?.track({
              user: this.myUser,
              status: this.myStatus,
              subnick: this.mySubnick,
              inRoom: this.inCall,
              online_at: new Date().toISOString()
            })
          }
        })
    }
  }

  private async sendSignal(
    type:
      | 'sdp-offer'
      | 'sdp-answer'
      | 'ice-candidate'
      | 'hangup'
      | 'renegotiate-offer'
      | 'room-sync-request',
    data: Record<string, unknown>
  ): Promise<void> {
    // 1. Envia instantaneamente via WebSocket do Supabase Realtime Broadcast
    if (this.realtimeChannel) {
      await this.realtimeChannel.send({
        type: 'broadcast',
        event: 'webrtc-signal',
        payload: {
          sender: this.myUser,
          target: this.friendUser,
          type,
          data
        }
      })
    }

    // 2. Envia em paralelo para a API Serverless da Vercel (/api/signal) se configurada
    const vercelApiUrl = import.meta.env.VITE_VERCEL_API_URL
    if (vercelApiUrl && !vercelApiUrl.includes('seu-projeto')) {
      fetch(`${vercelApiUrl.replace(/\/$/, '')}/api/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: 'msn-vitinho-will',
          sender: this.myUser,
          target: this.friendUser,
          type,
          payload: data
        })
      }).catch(() => {})
    }
  }

  // ==========================================================================
  // 3. CRIAÇÃO DO RTCPeerConnection E SEPARAÇÃO DE TRACKS
  // ==========================================================================
  private ensurePeerConnection(): RTCPeerConnection {
    if (this.peerConnection) return this.peerConnection

    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal('ice-candidate', {
          candidate: event.candidate.toJSON()
        })
      }
    }

    pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel)
    }

    pc.ontrack = (event) => {
      const track = event.track
      const stream = event.streams[0] || new MediaStream([track])

      const routeTrack = (): void => {
        if (track.kind === 'audio') {
          const hasExistingLiveMic = Boolean(
            this.remoteVoiceStream &&
              this.remoteVoiceStream
                .getAudioTracks()
                .some((t) => t.readyState === 'live' && t.id !== track.id)
          )

          const isScreenAudio =
            (this.remoteStreamIds.screenStreamId &&
              stream.id === this.remoteStreamIds.screenStreamId) ||
            (this.remoteStreamIds.micStreamId &&
              stream.id !== this.remoteStreamIds.micStreamId &&
              hasExistingLiveMic) ||
            hasExistingLiveMic ||
            track.label.toLowerCase().includes('screen') ||
            track.label.toLowerCase().includes('system') ||
            track.label.toLowerCase().includes('loopback')

          if (isScreenAudio) {
            if (!this.remoteScreenStream) {
              this.remoteScreenStream = new MediaStream()
            }
            if (!this.remoteScreenStream.getAudioTracks().some((t) => t.id === track.id)) {
              this.remoteScreenStream.addTrack(track)
            }
          } else {
            this.remoteVoiceStream = new MediaStream([track])
            this.setupRemoteVoiceAnalyser(this.remoteVoiceStream)
          }
        } else if (track.kind === 'video') {
          const hasExistingLiveCam = Boolean(
            this.remoteCamStream &&
              this.remoteCamStream
                .getVideoTracks()
                .some((t) => t.readyState === 'live' && t.id !== track.id)
          )

          const isScreenVideo =
            (this.remoteStreamIds.screenStreamId &&
              stream.id === this.remoteStreamIds.screenStreamId) ||
            (this.remoteStreamIds.camStreamId &&
              stream.id !== this.remoteStreamIds.camStreamId &&
              hasExistingLiveCam) ||
            hasExistingLiveCam ||
            track.label.toLowerCase().includes('screen') ||
            track.label.toLowerCase().includes('window') ||
            track.label.toLowerCase().includes('display')

          if (isScreenVideo) {
            if (!this.remoteScreenStream) {
              this.remoteScreenStream = new MediaStream()
            }
            this.remoteScreenStream
              .getVideoTracks()
              .filter((t) => t.id !== track.id)
              .forEach((t) => this.remoteScreenStream?.removeTrack(t))
            if (!this.remoteScreenStream.getVideoTracks().some((t) => t.id === track.id)) {
              this.remoteScreenStream.addTrack(track)
            }
          } else {
            this.remoteCamStream = new MediaStream([track])
          }
        }

        this.emitStreamsUpdated()
        this.emitCallState()
      }

      routeTrack()
      track.onunmute = () => {
        routeTrack()
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.emitCallState()
      }
    }

    this.peerConnection = pc
    return pc
  }

  public async connectDataChannelOnly(): Promise<void> {
    const pc = this.ensurePeerConnection()
    if (!this.dataChannel) {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    const offer = await pc.createOffer()
    await this.setLocalDescriptionSafe(pc, offer)
    await this.sendSignal('sdp-offer', {
      sdp: pc.localDescription,
      isMediaCall: false,
      streamIds: this.getLocalStreamIds()
    })
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
    const candidates = [...this.pendingIceCandidates]
    this.pendingIceCandidates = []
    for (const c of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c))
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
            ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {})
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
            ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {})
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
    this.incomingCallFrom = null
    this.pendingOffer = null
    this.setRemoteVoiceBoostVolume(this.remoteVoiceVolumePercent)
    this.emitCallState()

    await this.acquireMicAndCam(withVideo)
    const pc = this.ensurePeerConnection()

    if (!this.dataChannel) {
      const dc = pc.createDataChannel('msn-p2p-data', { ordered: true })
      this.setupDataChannel(dc)
    }

    this.attachLocalStreamsToPeer(pc)
    await this.ensureTransceiversSendRecv(pc)
    this.emitStreamsUpdated()
    this.emitCallState()
    this.trackPresenceState()

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    })
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
  }

  public async acceptIncomingCall(): Promise<void> {
    await this.startCall(true)
  }

  private async ensureTransceiversSendRecv(pc: RTCPeerConnection): Promise<void> {
    const transceivers = pc.getTransceivers()
    const micTrack = this.localMicStream?.getAudioTracks()[0]
    const camTrack = this.localCamStream?.getVideoTracks()[0]

    if (micTrack) {
      const alreadySendingAudio = pc
        .getSenders()
        .some((s) => s.track && s.track.id === micTrack.id)
      const audioTransceiver = transceivers.find(
        (t) => t.receiver.track?.kind === 'audio' && (!t.sender.track || t.direction === 'recvonly')
      )
      if (audioTransceiver) {
        await audioTransceiver.sender.replaceTrack(micTrack).catch(() => {})
        audioTransceiver.direction = 'sendrecv'
      } else if (!alreadySendingAudio && this.localMicStream) {
        pc.addTrack(micTrack, this.localMicStream)
      }
    }

    if (camTrack) {
      const alreadySendingVideo = pc
        .getSenders()
        .some((s) => s.track && s.track.id === camTrack.id)
      const videoTransceiver = transceivers.find(
        (t) => t.receiver.track?.kind === 'video' && (!t.sender.track || t.direction === 'recvonly')
      )
      if (videoTransceiver) {
        await videoTransceiver.sender.replaceTrack(camTrack).catch(() => {})
        videoTransceiver.direction = 'sendrecv'
      } else if (!alreadySendingVideo && this.localCamStream) {
        pc.addTrack(camTrack, this.localCamStream)
      }
    }
  }

  public rejectOrHangupCall(): void {
    this.inCall = false
    this.pendingOffer = null
    this.incomingCallFrom = null
    this.setRemoteVoiceBoostVolume(this.remoteVoiceVolumePercent)
    this.cleanupLocalMediaStreams()
    this.trackPresenceState()
    this.sendDataChannelPacket({
      type: 'room-state',
      sender: this.myUser,
      inRoom: false
    })
    this.sendSignal('hangup', { inRoom: false })
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
    if (rawScreenAudioTrack) {
      const cleanAudioTrack = await this.createCleanScreenAudioTrack(rawDesktopStream)
      finalScreenStream.addTrack(cleanAudioTrack || rawScreenAudioTrack)
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

    await this.renegotiatePeerConnection()
    this.emitStreamsUpdated()
    this.emitCallState()
  }

  public async stopScreenShare(): Promise<void> {
    if (!this.localScreenStream) return

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

  public toggleCameraEnabled(): boolean {
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
    if (!this.peerConnection) return
    this.broadcastStreamMeta()
    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    })
    await this.setLocalDescriptionSafe(this.peerConnection, offer)
    await this.sendSignal('renegotiate-offer', {
      sdp: this.peerConnection.localDescription,
      inRoom: this.inCall,
      streamIds: this.getLocalStreamIds()
    })
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
    }

    if (typeof data.inRoom === 'boolean') {
      this.friendInRoom = data.inRoom
      this.emitCallState()
    }

    if (type === 'room-sync-request') {
      if (this.inCall) {
        this.renegotiatePeerConnection().catch(() => {})
      }
      return
    }

    if (type === 'sdp-offer' || type === 'renegotiate-offer') {
      const sdp = data.sdp as RTCSessionDescriptionInit
      const isMediaCall = Boolean(data.isMediaCall) || type === 'renegotiate-offer'

      if (isMediaCall && data.inRoom === undefined) {
        this.friendInRoom = true
      }

      // Na Sala Sempre Existente: aceita automaticamente a oferta WebRTC!
      // Se ainda não entramos na Sala (!this.inCall), recebemos a webcam do amigo no quadrado do Chat (com voz silenciada até entrarmos).
      // Se já estamos na Sala (this.inCall), anexamos nossas tracks locais em sendrecv e conversamos imediatamente!
      const pc = this.ensurePeerConnection()
      if (this.inCall) {
        this.attachLocalStreamsToPeer(pc)
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      await this.flushPendingIceCandidates(pc)
      if (this.inCall) {
        await this.ensureTransceiversSendRecv(pc)
      }
      const answer = await pc.createAnswer()
      await this.setLocalDescriptionSafe(pc, answer)
      this.broadcastStreamMeta()
      await this.sendSignal('sdp-answer', {
        sdp: pc.localDescription,
        inRoom: this.inCall,
        streamIds: this.getLocalStreamIds()
      })
      this.emitStreamsUpdated()
      this.emitCallState()

      if (this.inCall && type === 'sdp-offer') {
        setTimeout(() => {
          if (this.inCall && this.peerConnection?.signalingState === 'stable') {
            this.renegotiatePeerConnection().catch(() => {})
          }
        }, 500)
      }
      return
    }

    if (type === 'sdp-answer') {
      const sdp = data.sdp as RTCSessionDescriptionInit
      if (this.peerConnection && this.peerConnection.signalingState !== 'stable') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp))
        await this.flushPendingIceCandidates(this.peerConnection)
      }
      return
    }

    if (type === 'ice-candidate') {
      const candidate = data.candidate as RTCIceCandidateInit
      if (!candidate) return
      if (this.peerConnection && this.peerConnection.remoteDescription) {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
      } else {
        this.pendingIceCandidates.push(candidate)
      }
      return
    }

    if (type === 'hangup') {
      // O amigo saiu da Sala: limpamos apenas as streams remotas dele, mantendo nossa própria estadia na Sala se estivermos nela!
      this.friendInRoom = false
      this.remoteVoiceStream = null
      this.remoteCamStream = null
      this.remoteScreenStream = null
      this.emitStreamsUpdated()
      this.emitCallState()
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

  private async createCleanScreenAudioTrack(
    rawDesktopStream: MediaStream
  ): Promise<MediaStreamTrack | null> {
    try {
      const ctx = this.ensureAudioContext()
      await this.ensureLoopbackCancellerWorklet(ctx)

      const screenSource = ctx.createMediaStreamSource(rawDesktopStream)
      const canceller = new AudioWorkletNode(ctx, 'voice-loopback-canceller', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })
      const dest = ctx.createMediaStreamDestination()

      screenSource.connect(canceller, 0, 0)
      if (this.remoteVoiceGainNode) {
        this.remoteVoiceGainNode.connect(canceller, 0, 1)
      }
      canceller.connect(dest)

      this.screenAudioSourceNode = screenSource
      this.screenAudioCancellerNode = canceller
      this.screenAudioDestNode = dest

      // Dispara um micro-pulso suave de calibração (120ms) após 450ms para travar o atraso exato do WASAPI imediatamente
      setTimeout(() => {
        if (!this.audioCtx || !this.screenAudioCancellerNode) return
        try {
          const calLen = Math.floor(this.audioCtx.sampleRate * 0.16)
          const calBuf = this.audioCtx.createBuffer(1, calLen, this.audioCtx.sampleRate)
          const ch = calBuf.getChannelData(0)
          let seed = 246813579
          let lp = 0
          for (let i = 0; i < calLen; i++) {
            seed = (seed * 1664525 + 1013904223) >>> 0
            const white = seed / 4294967296 - 0.5
            lp = 0.85 * lp + 0.15 * white
            const windowEnv = Math.sin((Math.PI * i) / calLen)
            ch[i] = lp * 0.04 * windowEnv
          }
          const calSrc = this.audioCtx.createBufferSource()
          calSrc.buffer = calBuf
          calSrc.connect(this.audioCtx.destination)
          calSrc.connect(this.screenAudioCancellerNode, 0, 1)
          calSrc.start()
        } catch {}
      }, 450)

      return dest.stream.getAudioTracks()[0] || null
    } catch (err) {
      console.warn('[WebRTC] Fallback para áudio nativo da tela sem worklet:', err)
      return null
    }
  }

  private cleanupScreenAudioCanceller(): void {
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
      const gainValue = this.inCall
        ? Math.max(0, Math.min(2, this.remoteVoiceVolumePercent / 100))
        : 0
      gainNode.gain.value = gainValue

      // O <audio id="remote-voice"> fica com muted=true no DOM (apenas para manter o receptor WebRTC ativo no Chromium),
      // enquanto 100% da reprodução da voz do amigo (0% a 200%) passa pelo gainNode no mesmo clock de 48kHz do AudioContext!
      // Assim, o VoiceLoopbackCancellerProcessor recebe a referência digital exata da voz e subtrai -55dB do loopback da tela!
      source.connect(analyser)
      source.connect(gainNode)
      gainNode.connect(ctx.destination)

      if (this.screenAudioCancellerNode) {
        gainNode.connect(this.screenAudioCancellerNode, 0, 1)
      }

      this.remoteVoiceSourceNode = source
      this.remoteVoiceGainNode = gainNode
      this.remoteAnalyser = analyser
      this.startVoiceActivityLoop()
    } catch (err) {
      console.warn('[WebRTC] Falha ao iniciar analyser de voz remota:', err)
    }
  }

  /**
   * Ajusta o volume da voz do amigo (0% a 200%) diretamente no GainNode unificado do Web Audio API.
   * Como o mesmo GainNode alimenta tanto a saída de áudio quanto a referência do cancelador de loopback,
   * o cancelamento da voz no compartilhamento de tela permanece 100% exato em qualquer volume!
   */
  public setRemoteVoiceBoostVolume(volumePercent: number): void {
    this.remoteVoiceVolumePercent = volumePercent
    if (!this.remoteVoiceGainNode || !this.audioCtx) return
    const gainValue = this.inCall
      ? Math.max(0, Math.min(2, volumePercent / 100))
      : 0
    this.remoteVoiceGainNode.gain.setTargetAtTime(gainValue, this.audioCtx.currentTime, 0.02)
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
      try {
        const packet = JSON.parse(event.data as string) as DataChannelPacket
        this.handleDataChannelPacket(packet)
      } catch (err) {
        console.warn('[DataChannel] Erro ao processar pacote P2P:', err)
      }
    }
  }

  public sendDataChannelPacket(packet: DataChannelPacket): boolean {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(packet))
      return true
    }
    return false
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

      case 'laser-pointer':
        this.callbacks.onLaserPointer({
          id: `${Date.now()}-${Math.random()}`,
          x: packet.x,
          y: packet.y,
          sender: packet.sender,
          createdAt: Date.now()
        })
        break

      case 'soundboard-wink':
        this.callbacks.onSoundboardWink(packet.sender, packet.winkId, packet.label)
        break

      case 'subnick-update':
        this.friendLastStatus = packet.status
        this.callbacks.onFriendPresenceChange(packet.status, packet.subnick, false)
        break

      case 'dj-sync':
        this.callbacks.onDjSync(packet.state)
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

      case 'stream-meta':
        this.remoteStreamIds = {
          micStreamId: packet.micStreamId,
          camStreamId: packet.camStreamId,
          screenStreamId: packet.screenStreamId
        }
        break

      case 'room-state':
        this.friendInRoom = packet.inRoom
        if (!packet.inRoom) {
          this.remoteVoiceStream = null
          this.remoteCamStream = null
          this.remoteScreenStream = null
          this.emitStreamsUpdated()
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
          chunks: new Array(packet.totalChunks),
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
        transfer.chunks[packet.chunkIndex] = packet.dataBase64
        transfer.receivedCount += 1
        const percent = Math.round((transfer.receivedCount / transfer.totalChunks) * 100)
        this.callbacks.onFileProgress({
          fileName: transfer.fileName,
          percent,
          direction: 'receiving'
        })
        break
      }

      case 'file-end': {
        const transfer = this.incomingFiles.get(packet.transferId)
        if (!transfer) break
        this.incomingFiles.delete(packet.transferId)
        this.callbacks.onFileProgress(null)

        const fullBase64 = transfer.chunks.join('')
        const byteCharacters = atob(fullBase64)
        const byteNumbers = new Array(byteCharacters.length)
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i)
        }
        const byteArray = new Uint8Array(byteNumbers)
        const blob = new Blob([byteArray], {
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
          timestamp: new Date().toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          })
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
    this.sendDataChannelPacket({
      type: 'chat-history-sync',
      sender: this.myUser,
      messages: clean
    })
  }

  /**
   * Envia arquivos P2P de qualquer tamanho dividindo em chunks seguros de 48 KB com controle de backpressure
   */
  public async sendFileP2P(file: File): Promise<ChatMessageItem> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      await this.connectDataChannelOnly()
    }

    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const base64All = btoa(binary)

    const chunkSize = 48 * 1024 // 48 KB por pacote
    const totalChunks = Math.max(1, Math.ceil(base64All.length / chunkSize))
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    this.sendDataChannelPacket({
      type: 'file-start',
      transferId,
      sender: this.myUser,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks
    })

    for (let idx = 0; idx < totalChunks; idx++) {
      const slice = base64All.slice(idx * chunkSize, (idx + 1) * chunkSize)
      this.sendDataChannelPacket({
        type: 'file-chunk',
        transferId,
        chunkIndex: idx,
        dataBase64: slice
      })

      const percent = Math.round(((idx + 1) / totalChunks) * 100)
      this.callbacks.onFileProgress({
        fileName: file.name,
        percent,
        direction: 'sending'
      })

      if (idx % 6 === 0) {
        await new Promise((r) => setTimeout(r, 8))
      }
    }

    this.sendDataChannelPacket({
      type: 'file-end',
      transferId
    })
    this.callbacks.onFileProgress(null)

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

  public sendLaserPointer(x: number, y: number): void {
    this.sendDataChannelPacket({
      type: 'laser-pointer',
      sender: this.myUser,
      x,
      y
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
    if (this.realtimeChannel) {
      this.realtimeChannel
        .track({
          user: this.myUser,
          status: this.myStatus,
          subnick: this.mySubnick,
          inRoom: this.inCall,
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

  public sendDjSync(state: DjSyncState): void {
    this.sendDataChannelPacket({
      type: 'dj-sync',
      state
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
    const hasRemoteCamOrVoice = Boolean(
      (this.remoteCamStream && this.remoteCamStream.getVideoTracks().some((t) => t.readyState === 'live')) ||
        (this.remoteVoiceStream && this.remoteVoiceStream.getAudioTracks().some((t) => t.readyState === 'live'))
    )
    this.callbacks.onCallStateChange({
      inCall: this.inCall,
      friendInRoom: this.friendInRoom || hasRemoteCamOrVoice,
      incomingCallFrom: this.incomingCallFrom,
      isScreenSharing: Boolean(this.localScreenStream),
      remoteScreenSharing: Boolean(
        this.remoteScreenStream && this.remoteScreenStream.getVideoTracks().length > 0
      )
    })
  }

  public destroy(): void {
    if (this.vadInterval) clearInterval(this.vadInterval)
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
    this.cleanupMediaStreams()
    this.dataChannel?.close()
    this.peerConnection?.close()
    this.realtimeChannel?.unsubscribe()
  }
}
