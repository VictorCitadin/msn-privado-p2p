import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Video,
  VideoOff,
  Monitor,
  MonitorOff,
  BellRing,
  Disc,
  Trophy,
  Gamepad2,
  RefreshCw,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Paperclip,
  Volume2,
  Sparkles,
  LogOut,
  Download,
  ShieldCheck,
  Maximize2,
  Minimize2,
  Settings,
  X
} from 'lucide-react'
import {
  MsnWebRTCService,
  MsnUser,
  PresenceStatus,
  ChatMessageItem,
  DjTrackItem,
  DjSyncState,
  LaserPointerPoint
} from './services/webrtc'
import {
  soundManager,
  SOUNDBOARD_ITEMS,
  SoundboardWinkId
} from './services/soundManager'
import { ScreenShareModal } from './components/ScreenShareModal'
import { DJBotDrawer } from './components/DJBotDrawer'
import { AlbumRankerWindow } from './components/AlbumRankerWindow'

// Avatares Nostálgicos Frutiger Aero / MSN em SVG Data URI para Vitinho e Will
const AVATAR_VITINHO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0284c7"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
      <linearGradient id="b1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="100%" stop-color="#0369a1"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="18" fill="url(#g1)"/>
    <circle cx="60" cy="44" r="21" fill="url(#b1)" stroke="#e0f2fe" stroke-width="3"/>
    <path d="M24 102 C24 72, 96 72, 96 102 Z" fill="url(#b1)" stroke="#e0f2fe" stroke-width="3"/>
    <text x="60" y="114" font-family="Tahoma" font-size="11" font-weight="bold" fill="#7dd3fc" text-anchor="middle">VITINHO</text>
  </svg>`)

const AVATAR_WILL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs>
      <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#15803d"/>
        <stop offset="100%" stop-color="#052e16"/>
      </linearGradient>
      <linearGradient id="b2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4ade80"/>
        <stop offset="100%" stop-color="#15803d"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="18" fill="url(#g2)"/>
    <circle cx="60" cy="44" r="21" fill="url(#b2)" stroke="#dcfce7" stroke-width="3"/>
    <path d="M24 102 C24 72, 96 72, 96 102 Z" fill="url(#b2)" stroke="#dcfce7" stroke-width="3"/>
    <text x="60" y="114" font-family="Tahoma" font-size="11" font-weight="bold" fill="#86efac" text-anchor="middle">WILL</text>
  </svg>`)

export function App(): React.ReactElement {
  // Se a rota for #/album-ranker, renderiza a TELA 6 (Segunda Janela Dedicada do Rankeador de Álbuns)
  const [routeHash, setRouteHash] = useState<string>(window.location.hash)

  useEffect(() => {
    const onHashChange = (): void => setRouteHash(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (routeHash.startsWith('#/album-ranker')) {
    return <AlbumRankerWindow />
  }

  return <MainMsnMessengerWindow />
}

const MainMsnMessengerWindow: React.FC = () => {
  // ==========================================================================
  // ESTADOS DE LOGIN E ATUALIZAÇÃO (TELA 1)
  // ==========================================================================
  const [loggedInUser, setLoggedInUser] = useState<MsnUser | null>(null)
  const [selectedLoginUser, setSelectedLoginUser] = useState<MsnUser>('Vitinho')
  const [pinInput, setPinInput] = useState<string>('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string>('1.0.0')
  const [updaterInfo, setUpdaterInfo] = useState<{
    status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
    version?: string
    percent?: number
    message: string
  }>({ status: 'idle', message: '' })

  // ==========================================================================
  // ESTADOS DO MSN MESSENGER (TELA 2, 3, 4 e 5)
  // ==========================================================================
  const [myStatus, setMyStatus] = useState<PresenceStatus>('online')
  const [customSubnick, setCustomSubnick] = useState<string>('')
  const [musicSubnick, setMusicSubnick] = useState<string | null>(null)
  const [friendStatus, setFriendStatus] = useState<PresenceStatus>('offline')
  const [friendSubnick, setFriendSubnick] = useState<string>('')

  const [messages, setMessages] = useState<ChatMessageItem[]>([])
  const messagesLoadedRef = useRef<boolean>(false)
  const messagesRef = useRef<ChatMessageItem[]>([])
  const [chatInput, setChatInput] = useState<string>('')
  const [fileProgress, setFileProgress] = useState<{
    fileName: string
    percent: number
    direction: 'sending' | 'receiving'
  } | null>(null)
  const [isDraggingOverChat, setIsDraggingOverChat] = useState<boolean>(false)

  // Dispositivos de Microfone e Webcam selecionáveis (antes ou durante a ligação)
  const [deviceModalOpen, setDeviceModalOpen] = useState<boolean>(false)
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string>('')
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>('')

  // Estados de Sala Sempre Existente (Tela 3) e Compartilhamento de Tela Modo Cinema (Tela 4)
  const [inCall, setInCall] = useState<boolean>(false)
  const [callHealth, setCallHealth] = useState<'connecting' | 'healthy' | 'degraded' | 'recovering' | 'dead'>('connecting')
  const [friendInRoom, setFriendInRoom] = useState<boolean>(false)
  const [roomViewActive, setRoomViewActive] = useState<boolean>(false)
  const [hasLocalCam, setHasLocalCam] = useState<boolean>(false)
  const [hasRemoteCam, setHasRemoteCam] = useState<boolean>(false)
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false)
  const [remoteScreenSharing, setRemoteScreenSharing] = useState<boolean>(false)
  const [screenModalOpen, setScreenModalOpen] = useState<boolean>(false)

  const [isMicMuted, setIsMicMuted] = useState<boolean>(false)
  const [isCamEnabled, setIsCamEnabled] = useState<boolean>(true)
  const [ecoMode, setEcoMode] = useState<boolean>(false)
  const [isWindowVisible, setIsWindowVisible] = useState<boolean>(true)
  const [isCallFullscreen, setIsCallFullscreen] = useState<boolean>(false)
  const [nudgeCooldown, setNudgeCooldown] = useState<number>(0)

  // Cooldown de 5 segundos para Chamar Atenção (Nudge)
  useEffect(() => {
    if (nudgeCooldown <= 0) return
    const timer = setInterval(() => {
      setNudgeCooldown((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [nudgeCooldown])

  // Mixers Independentes: Voz do Amigo (0% a 200% Boost) e Volume do Filme/Tela (0% a 100%)
  const [friendVoiceVolume, setFriendVoiceVolume] = useState<number>(100)
  const [screenMovieVolume, setScreenMovieVolume] = useState<number>(85)

  // Auto-Hide UI (3s) no Modo Cinema
  const [cinemaControlsVisible, setCinemaControlsVisible] = useState<boolean>(true)
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Posições Arrastáveis (Draggable) das 2 Câmeras nos Cantos Superiores no Modo Cinema (Tela 4)
  const [myCornerCamPos, setMyCornerCamPos] = useState<{ x: number; y: number }>({
    x: 16,
    y: 16
  })
  const [friendCornerCamPos, setFriendCornerCamPos] = useState<{ x: number; y: number }>({
    x: 252,
    y: 16
  })
  const draggingCamRef = useRef<{
    target: 'my' | 'friend'
    offsetX: number
    offsetY: number
  } | null>(null)

  // DJ Bot WMP (Tela 5)
  const [djDrawerOpen, setDjDrawerOpen] = useState<boolean>(false)
  const [isAnyoneSpeaking, setIsAnyoneSpeaking] = useState<boolean>(false)
  const [djState, setDjState] = useState<DjSyncState>({
    playlist: [],
    currentIndex: 0,
    isPlaying: false,
    currentTime: 0,
    updatedBy: 'Vitinho',
    updatedAt: Date.now()
  })

  // Referências de Mídia e Serviço WebRTC
  const webrtcRef = useRef<MsnWebRTCService | null>(null)
  const streamsRef = useRef<{
    localCam: MediaStream | null
    localScreen: MediaStream | null
    remoteVoice: MediaStream | null
    remoteCam: MediaStream | null
    remoteScreen: MediaStream | null
  }>({
    localCam: null,
    localScreen: null,
    remoteVoice: null,
    remoteCam: null,
    remoteScreen: null
  })

  const remoteVoiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const remoteScreenAudioRef = useRef<HTMLAudioElement | null>(null)
  const localCamElementsRef = useRef<Set<HTMLVideoElement>>(new Set())
  const remoteCamElementsRef = useRef<Set<HTMLVideoElement>>(new Set())
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const friendUser: MsnUser = loggedInUser === 'Vitinho' ? 'Will' : 'Vitinho'
  const effectiveMySubnick = musicSubnick
    ? `🎵 Ouvindo: ${musicSubnick}`
    : customSubnick

  // ==========================================================================
  // 1. CARREGAR SESSÃO SALVA, HISTÓRICO DE MENSAGENS, DISPOSITIVOS E EVENTOS
  // ==========================================================================
  const refreshMediaDevices = useCallback(async (unlockLabels = false) => {
    try {
      let list = await navigator.mediaDevices.enumerateDevices()
      const hasEmptyLabels = list.some(
        (d) => (d.kind === 'audioinput' || d.kind === 'videoinput') && !d.label
      )
      if (unlockLabels && hasEmptyLabels) {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true
          })
          tempStream.getTracks().forEach((t) => t.stop())
          list = await navigator.mediaDevices.enumerateDevices()
        } catch {
          try {
            const tempAudio = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false
            })
            tempAudio.getTracks().forEach((t) => t.stop())
            list = await navigator.mediaDevices.enumerateDevices()
          } catch {}
        }
      }
      setAudioDevices(list.filter((d) => d.kind === 'audioinput'))
      setVideoDevices(list.filter((d) => d.kind === 'videoinput'))
    } catch (err) {
      console.warn('[Devices] Erro ao listar dispositivos de áudio/vídeo:', err)
    }
  }, [])

  useEffect(() => {
    window.msnApi.getAppVersion().then(setAppVersion).catch(() => {})

    window.msnApi
      .getSession()
      .then((saved) => {
        if (saved.sessionUser) {
          setLoggedInUser(saved.sessionUser)
          setSelectedLoginUser(saved.sessionUser)
        }
        if (typeof saved.subnick === 'string') {
          const clean =
            saved.subnick === 'Disponível no MSN Privado 🎮' ? '' : saved.subnick
          setCustomSubnick(clean)
        }
        if (typeof saved.ecoMode === 'boolean') setEcoMode(saved.ecoMode)
        if (typeof saved.audioDeviceId === 'string')
          setSelectedAudioDeviceId(saved.audioDeviceId)
        if (typeof saved.videoDeviceId === 'string')
          setSelectedVideoDeviceId(saved.videoDeviceId)
        if (Array.isArray(saved.chatMessages) && saved.chatMessages.length > 0) {
          setMessages(saved.chatMessages)
          messagesRef.current = saved.chatMessages
        }
        messagesLoadedRef.current = true
      })
      .catch(() => {
        messagesLoadedRef.current = true
        const localUser = localStorage.getItem('msn_session_user') as MsnUser | null
        if (localUser === 'Vitinho' || localUser === 'Will') {
          setLoggedInUser(localUser)
        }
      })

    refreshMediaDevices(false)
    const onDeviceChange = (): void => {
      refreshMediaDevices(false)
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)

    const unsubVisibility = window.msnApi.onWindowVisibilityChanged((visible) => {
      setIsWindowVisible(visible)
      if (!visible) {
        document.body.classList.add('animations-paused')
      } else {
        document.body.classList.remove('animations-paused')
      }
    })

    const unsubUpdater = window.msnApi.onUpdaterStatus((payload) => {
      setUpdaterInfo(payload)
    })

    const unsubFullscreen = window.msnApi.onFullscreenChanged((isFull) => {
      setIsCallFullscreen(isFull)
    })

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
      unsubVisibility()
      unsubUpdater()
      unsubFullscreen()
    }
  }, [refreshMediaDevices])

  // Auto-esconde a mensagem "Você já está na versão mais recente..." ou de erro após 4 segundos
  useEffect(() => {
    if (updaterInfo.status === 'up-to-date' || updaterInfo.status === 'error') {
      const timer = setTimeout(() => {
        setUpdaterInfo({ status: 'idle', message: '' })
      }, 4000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [updaterInfo])

  // Salva automaticamente o histórico de mensagens no electron-store sempre que mudar
  useEffect(() => {
    messagesRef.current = messages
    if (!messagesLoadedRef.current) return
    window.msnApi.saveChatMessages(messages).catch(() => {})
  }, [messages])

  // Toca som ao alguém entrar na Sala de ligação e som ao alguém sair da Sala
  const prevInCallRef = useRef<boolean>(false)
  const prevFriendInRoomRef = useRef<boolean>(false)
  useEffect(() => {
    const myJoined = !prevInCallRef.current && inCall
    const myLeft = prevInCallRef.current && !inCall
    const friendJoined = !prevFriendInRoomRef.current && friendInRoom
    const friendLeft = prevFriendInRoomRef.current && !friendInRoom

    prevInCallRef.current = inCall
    prevFriendInRoomRef.current = friendInRoom

    if (myJoined || friendJoined) {
      soundManager.play('room-join')
    } else if (myLeft || friendLeft) {
      soundManager.play('room-leave')
    }
  }, [inCall, friendInRoom])

  // ==========================================================================
  // 2. CONGELAMENTO DE RENDERIZAÇÃO DE VÍDEO QUANDO MINIMIZADO/OCULTO (0% GPU)
  // ==========================================================================
  const syncMediaElementsWithVisibility = useCallback(() => {
    const st = streamsRef.current

    // O <audio id="remote-voice"> reproduz diretamente a voz do amigo com estabilidade absoluta e latência zero
    if (remoteVoiceAudioRef.current) {
      remoteVoiceAudioRef.current.muted = false
      remoteVoiceAudioRef.current.volume = 1.0
      if (remoteVoiceAudioRef.current.srcObject !== st.remoteVoice) {
        remoteVoiceAudioRef.current.srcObject = st.remoteVoice
        remoteVoiceAudioRef.current.play().catch(() => {})
      }
    }

    // O <audio id="remote-screen-audio"> reproduz o som do filme/sistema sem engasgos
    if (remoteScreenAudioRef.current) {
      const screenAudioStream = st.remoteScreen
      if (
        !isScreenSharing &&
        remoteScreenSharing &&
        screenAudioStream &&
        screenAudioStream.getAudioTracks().length > 0
      ) {
        remoteScreenAudioRef.current.muted = false
        remoteScreenAudioRef.current.volume = djState.isPlaying
          ? 0
          : Math.max(0, Math.min(1, screenMovieVolume / 100))
        if (remoteScreenAudioRef.current.srcObject !== screenAudioStream) {
          remoteScreenAudioRef.current.srcObject = screenAudioStream
          remoteScreenAudioRef.current.play().catch(() => {})
        }
      } else {
        if (remoteScreenAudioRef.current.srcObject !== null) {
          remoteScreenAudioRef.current.srcObject = null
          remoteScreenAudioRef.current.pause()
        }
      }
    }

    // Se a janela estiver minimizada/oculta no System Tray ou em Modo Eco sem foco, desconecta o srcObject dos <video>
    if (!isWindowVisible) {
      for (const el of localCamElementsRef.current) {
        if (el.isConnected) el.srcObject = null
      }
      for (const el of remoteCamElementsRef.current) {
        if (el.isConnected) el.srcObject = null
      }
      if (remoteScreenVideoRef.current && remoteScreenVideoRef.current.srcObject !== null) {
        remoteScreenVideoRef.current.srcObject = null
        remoteScreenVideoRef.current.pause()
        remoteScreenVideoRef.current.removeAttribute('src')
        remoteScreenVideoRef.current.load()
      }
      return
    }

    // Restaura TODOS os vídeos de câmera local conectados no DOM
    for (const el of localCamElementsRef.current) {
      if (el.isConnected && el.srcObject !== st.localCam) {
        el.srcObject = st.localCam
        el.play().catch(() => {})
      }
    }

    // Restaura TODOS os vídeos de câmera remota conectados no DOM (avatar, sala 1x1, modo cinema)
    for (const el of remoteCamElementsRef.current) {
      if (el.isConnected && el.srcObject !== st.remoteCam) {
        el.srcObject = st.remoteCam
        el.play().catch(() => {})
      }
    }

    // Vídeo da Tela Compartilhada (Modo Cinema): limpa imediatamente ao parar de compartilhar
    const activeScreenStream = st.remoteScreen || st.localScreen
    if (remoteScreenVideoRef.current) {
      if (activeScreenStream && (isScreenSharing || remoteScreenSharing)) {
        if (remoteScreenVideoRef.current.srcObject !== activeScreenStream) {
          remoteScreenVideoRef.current.srcObject = activeScreenStream
          remoteScreenVideoRef.current.play().catch(() => {})
        }
      } else {
        if (remoteScreenVideoRef.current.srcObject !== null) {
          remoteScreenVideoRef.current.srcObject = null
          remoteScreenVideoRef.current.pause()
          remoteScreenVideoRef.current.removeAttribute('src')
          remoteScreenVideoRef.current.load()
        }
      }
    }
  }, [isWindowVisible, isScreenSharing, remoteScreenSharing, djState.isPlaying, screenMovieVolume])

  const bindLocalCamRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el) {
        localCamElementsRef.current.add(el)
        if (isWindowVisible && streamsRef.current.localCam) {
          if (el.srcObject !== streamsRef.current.localCam) {
            el.srcObject = streamsRef.current.localCam
            el.play().catch(() => {})
          }
        }
      } else {
        for (const video of localCamElementsRef.current) {
          if (!video.isConnected) {
            video.srcObject = null
            localCamElementsRef.current.delete(video)
          }
        }
      }
    },
    [isWindowVisible]
  )

  const bindRemoteCamRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el) {
        remoteCamElementsRef.current.add(el)
        if (isWindowVisible && streamsRef.current.remoteCam) {
          if (el.srcObject !== streamsRef.current.remoteCam) {
            el.srcObject = streamsRef.current.remoteCam
            el.play().catch(() => {})
          }
        }
      } else {
        for (const video of remoteCamElementsRef.current) {
          if (!video.isConnected) {
            video.srcObject = null
            remoteCamElementsRef.current.delete(video)
          }
        }
      }
    },
    [isWindowVisible]
  )

  useEffect(() => {
    syncMediaElementsWithVisibility()
  }, [
    isWindowVisible,
    inCall,
    friendInRoom,
    roomViewActive,
    hasLocalCam,
    hasRemoteCam,
    isScreenSharing,
    remoteScreenSharing,
    syncMediaElementsWithVisibility
  ])

  // Ajusta o volume do filme/tela compartilhada (0% a 100%) e da voz do amigo
  // Além disso, silencia o áudio da tela compartilhada enquanto o DJ Bot estiver tocando para nunca tocar a música 2x!
  useEffect(() => {
    webrtcRef.current?.setDjBotPlayingState(djState.isPlaying)
    const targetVolume = djState.isPlaying ? 0 : Math.max(0, Math.min(1, screenMovieVolume / 100))
    if (remoteScreenAudioRef.current) {
      remoteScreenAudioRef.current.volume = targetVolume
    }
    if (remoteScreenVideoRef.current) {
      remoteScreenVideoRef.current.volume = targetVolume
    }
  }, [screenMovieVolume, isScreenSharing, remoteScreenSharing, djState.isPlaying])

  useEffect(() => {
    webrtcRef.current?.setRemoteVoiceBoostVolume(friendVoiceVolume)
  }, [friendVoiceVolume, inCall])

  // Sai automaticamente da Tela Cheia quando a ligação é encerrada, e suporta tecla Esc / F11 na chamada
  useEffect(() => {
    if (!inCall && isCallFullscreen) {
      window.msnApi.setFullscreen(false).catch(() => {})
      setIsCallFullscreen(false)
    }
  }, [inCall, isCallFullscreen])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!inCall) return
      if (e.key === 'Escape' && isCallFullscreen) {
        window.msnApi.setFullscreen(false).catch(() => {})
      } else if (e.key === 'F11') {
        e.preventDefault()
        window.msnApi.toggleFullscreen().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inCall, isCallFullscreen])

  const handleToggleCallFullscreen = (): void => {
    window.msnApi.toggleFullscreen().catch(() => {})
  }

  // ==========================================================================
  // 3. INICIALIZAR SERVIÇO WEBRTC APÓS LOGIN
  // ==========================================================================
  useEffect(() => {
    if (!loggedInUser) return

    const service = new MsnWebRTCService(loggedInUser, {
      onFriendPresenceChange: (status, subnick, justLoggedIn) => {
        setFriendStatus(status)
        setFriendSubnick(subnick)
        if (justLoggedIn) {
          soundManager.play('login')
          window.msnApi.showNativeNotification(
            'Vitinho e Will',
            `${loggedInUser === 'Vitinho' ? 'Will' : 'Vitinho'} acabou de entrar!`
          )
        }
      },
      onChatMessage: (msg) => {
        soundManager.play('message')
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, msg]
        })
      },
      onChatHistorySync: (remoteMsgs) => {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id))
          const missing = remoteMsgs.filter((m) => m?.id && !existingIds.has(m.id))
          if (missing.length === 0) return prev
          return [...prev, ...missing].slice(-300)
        })
      },
      onDataChannelOpen: () => {
        if (messagesRef.current.length > 0) {
          service.sendChatHistorySync(messagesRef.current)
        }
      },
      onNudgeReceived: (sender) => {
        soundManager.play('nudge')
        window.msnApi.nudgeWindow()
        setMessages((prev) => [
          ...prev,
          {
            id: `nudge-${Date.now()}`,
            sender,
            text: `🔔 ${sender} acabou de chamar sua atenção!`,
            isSystem: true,
            timestamp: new Date().toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            })
          }
        ])
      },
      onSoundboardWink: (sender, winkId, label) => {
        soundManager.playSoundboardWink(winkId)
        setMessages((prev) => [
          ...prev,
          {
            id: `wink-${Date.now()}`,
            sender,
            text: `🔊 ${sender} enviou um Wink sonoro: ${label}`,
            isSystem: true,
            timestamp: new Date().toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            })
          }
        ])
      },
      onDjSync: (state) => {
        setDjState(state)
      },
      onAlbumRankedNotification: (payload) => {
        soundManager.play('message')
        window.msnApi.showNativeNotification(
          '🏆 Novo Álbum Rankeado!',
          `${payload.user} acabou de rankear o álbum "${payload.albumName}" (${payload.rating.toFixed(1)} ⭐)!`
        )
        setMessages((prev) => [
          ...prev,
          {
            id: `rank-${Date.now()}`,
            sender: payload.user,
            text: `🏆 ${payload.user} acabou de rankear o álbum "${payload.albumName}" (${payload.artistName}) com nota ${payload.rating.toFixed(1)}/5.0! Abra o Rankeador de Álbuns para comparar!`,
            isSystem: true,
            timestamp: new Date().toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            })
          }
        ])
      },
      onCallStateChange: (state) => {
        setInCall(state.inCall)
        setCallHealth(state.callHealth)
        setFriendInRoom(state.friendInRoom)
        setIsScreenSharing(state.isScreenSharing)
        setRemoteScreenSharing(state.remoteScreenSharing)
        if (!state.inCall) {
          setRoomViewActive(false)
          setIsScreenSharing(false)
          setRemoteScreenSharing(false)
        }
        if (!state.isScreenSharing && !state.remoteScreenSharing) {
          if (remoteScreenVideoRef.current) {
            remoteScreenVideoRef.current.srcObject = null
            remoteScreenVideoRef.current.pause()
            remoteScreenVideoRef.current.removeAttribute('src')
            remoteScreenVideoRef.current.load()
          }
          if (remoteScreenAudioRef.current) {
            remoteScreenAudioRef.current.srcObject = null
            remoteScreenAudioRef.current.pause()
          }
        }
        soundManager.stopRingLoop()
      },
      onCallDropped: (reason) => {
        soundManager.play('room-leave')
        setRoomViewActive(false)
        setInCall(false)
        setCallHealth('dead')
        setIsScreenSharing(false)
        setRemoteScreenSharing(false)
        window.msnApi?.showNativeNotification?.(
          'MSN Privado - Ligação Encerrada',
          `A ligação caiu ou foi encerrada: ${reason}`
        )
        setMessages((prev) => [
          ...prev,
          {
            id: `drop-${Date.now()}`,
            sender: loggedInUser,
            text: `⚠️ A ligação caiu (${reason}). Você saiu da sala de conferência.`,
            isSystem: true,
            timestamp: new Date().toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            })
          }
        ])
      },
      onStreamsUpdated: (streams) => {
        streamsRef.current = streams
        setHasLocalCam(Boolean(streams.localCam && streams.localCam.getVideoTracks().length > 0))
        setHasRemoteCam(Boolean(streams.remoteCam && streams.remoteCam.getVideoTracks().length > 0))
        syncMediaElementsWithVisibility()
      },
      onVoiceActivityChange: (speaking) => {
        setIsAnyoneSpeaking(speaking)
      },
      onFileProgress: (info) => {
        setFileProgress(info)
      }
    })

    webrtcRef.current = service
    service.setEcoMode(ecoMode)
    service.setPreferredDevices(selectedAudioDeviceId, selectedVideoDeviceId).catch(() => {})

    const handleUserInteraction = (): void => {
      service.resumeAudioContext()
    }
    window.addEventListener('click', handleUserInteraction, { once: true })
    window.addEventListener('keydown', handleUserInteraction, { once: true })

    // Atalho Global Ctrl+Shift+M para mutar microfone durante jogos em tela cheia com bip sonoro
    const unsubMute = window.msnApi.onGlobalMuteShortcut(() => {
      const nowMuted = service.toggleMicrophoneMute()
      setIsMicMuted(nowMuted)
      soundManager.play(nowMuted ? 'mute' : 'unmute')
    })

    // Quando o usuário salva um ranking na janela do Rankeador, avisa o amigo via DataChannel P2P
    const unsubAlbumBroadcast = window.msnApi.onAlbumRankedBroadcast((payload) => {
      service.sendAlbumRankedAlert(payload)
      setMessages((prev) => [
        ...prev,
        {
          id: `my-rank-${Date.now()}`,
          sender: payload.user,
          text: `🏆 Você acabou de rankear o álbum "${payload.albumName}" (${payload.rating.toFixed(1)} ⭐)!`,
          isSystem: true,
          timestamp: new Date().toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          })
        }
      ])
    })

    // Quando o usuário clica em "🎧 Ouvir Álbum Juntos no DJ Bot" na janela do Rankeador
    const unsubQueueAlbum = window.msnApi.onDjBotQueueAlbum(async (payload) => {
      setDjDrawerOpen(true)
      const resolvedTracks: DjTrackItem[] = []
      for (const item of payload.tracks.slice(0, 15)) {
        try {
          const res = await window.msnApi.resolveDjTrack(
            `${payload.artistName} ${item.trackName} official audio`
          )
          resolvedTracks.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            videoId: res.videoId,
            title: res.title,
            author: res.author,
            durationSeconds: res.durationSeconds,
            thumbnail: res.thumbnail,
            addedBy: loggedInUser
          })
        } catch {
          // continua para a próxima faixa
        }
      }

      if (resolvedTracks.length > 0) {
        setDjState((prev) => {
          const nextState: DjSyncState = {
            playlist: [...prev.playlist, ...resolvedTracks],
            currentIndex: prev.playlist.length === 0 ? 0 : prev.currentIndex,
            isPlaying: true,
            currentTime: prev.playlist.length === 0 ? 0 : prev.currentTime,
            updatedBy: loggedInUser,
            updatedAt: Date.now()
          }
          service.sendDjSync(nextState)
          return nextState
        })
      }
    })

    const handleBeforeUnload = (): void => {
      service.destroy()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      unsubMute()
      unsubAlbumBroadcast()
      unsubQueueAlbum()
      service.destroy()
      webrtcRef.current = null
    }
  }, [loggedInUser])

  // Atualiza subnick automaticamente para "🎵 Ouvindo: [Nome da Música]" quando o DJ Bot toca
  useEffect(() => {
    if (!loggedInUser || !webrtcRef.current) return
    webrtcRef.current.sendSubnickAndStatus(effectiveMySubnick, myStatus)
  }, [effectiveMySubnick, myStatus, loggedInUser])

  // Scroll automático no histórico de chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ==========================================================================
  // 4. HANDLERS DE INTERAÇÃO (LOGIN, CHAT, NUDGE, CHAMADAS, ARRASTAR CÂMERAS)
  // ==========================================================================
  const handleLoginSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const expectedPinVitinho = import.meta.env.VITE_PIN_VITINHO || '1234'
    const expectedPinWill = import.meta.env.VITE_PIN_WILL || '4321'
    const expectedPin =
      selectedLoginUser === 'Vitinho' ? expectedPinVitinho : expectedPinWill

    if (pinInput.trim() !== expectedPin) {
      setLoginError(
        `PIN incorreto para ${selectedLoginUser}. (Dica padrão: Vitinho=${expectedPinVitinho}, Will=${expectedPinWill})`
      )
      return
    }

    setLoginError(null)
    setLoggedInUser(selectedLoginUser)
    localStorage.setItem('msn_session_user', selectedLoginUser)
    await window.msnApi.setSession({ sessionUser: selectedLoginUser })
    soundManager.play('login')
  }

  const handleLogout = async (): Promise<void> => {
    webrtcRef.current?.destroy()
    setLoggedInUser(null)
    setPinInput('')
    localStorage.removeItem('msn_session_user')
    await window.msnApi.setSession({ sessionUser: null })
  }

  const handleSendText = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!chatInput.trim() || !webrtcRef.current) return
    const sent = webrtcRef.current.sendChatMessage(chatInput.trim())
    setMessages((prev) => [...prev, sent])
    setChatInput('')
  }

  // Suporte a colar Prints da Área de Transferência (Ctrl+V) direto no Chat
  const handleChatPaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items
    if (!items || !webrtcRef.current) return

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const sent = webrtcRef.current?.sendChatMessage(
            '📸 Print colado da área de transferência:',
            dataUrl
          )
          if (sent) setMessages((prev) => [...prev, sent])
        }
        reader.readAsDataURL(blob)
        break
      }
    }
  }

  // Envio P2P de Arquivos sem limite de tamanho (Drag-and-Drop ou seletor)
  const handleFilesSelected = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || !webrtcRef.current) return
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const msg = await webrtcRef.current.sendFileP2P(file)
      setMessages((prev) => [...prev, msg])
    }
  }

  // Chamar Atenção (Nudge): toca nudge.mp3 + treme a janela física do Electron por 600ms com cooldown de 5s
  const handleTriggerNudge = (): void => {
    if (!loggedInUser || !webrtcRef.current || nudgeCooldown > 0) return
    setNudgeCooldown(5)
    soundManager.play('nudge')
    window.msnApi.nudgeWindow()
    webrtcRef.current.sendNudge()
    setMessages((prev) => [
      ...prev,
      {
        id: `nudge-me-${Date.now()}`,
        sender: loggedInUser,
        text: `🔔 Você acabou de chamar a atenção de ${friendUser}!`,
        isSystem: true,
        timestamp: new Date().toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        })
      }
    ])
  }

  // Soundboard / Winks (5 botões sincronizados)
  const handleTriggerWink = (winkId: SoundboardWinkId, label: string): void => {
    if (!loggedInUser || !webrtcRef.current) return
    soundManager.playSoundboardWink(winkId)
    webrtcRef.current.sendSoundboardWink(winkId, label)
    setMessages((prev) => [
      ...prev,
      {
        id: `wink-me-${Date.now()}`,
        sender: loggedInUser,
        text: `🔊 Você enviou o Wink sonoro: ${label}`,
        isSystem: true,
        timestamp: new Date().toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        })
      }
    ])
  }

  const handleSelectAudioDevice = async (deviceId: string): Promise<void> => {
    setSelectedAudioDeviceId(deviceId)
    await webrtcRef.current?.setPreferredDevices(deviceId, selectedVideoDeviceId)
    await window.msnApi.setSession({
      sessionUser: loggedInUser,
      audioDeviceId: deviceId
    })
  }

  const handleSelectVideoDevice = async (deviceId: string): Promise<void> => {
    setSelectedVideoDeviceId(deviceId)
    await webrtcRef.current?.setPreferredDevices(selectedAudioDeviceId, deviceId)
    await window.msnApi.setSession({
      sessionUser: loggedInUser,
      videoDeviceId: deviceId
    })
  }

  // Alternar Modo Jogo (OFF = padrão, ON = economiza GPU de animações em segundo plano mantendo câmera fluida sem zoom)
  const handleToggleEcoMode = async (): Promise<void> => {
    const next = !ecoMode
    setEcoMode(next)
    webrtcRef.current?.setEcoMode(next)
    await window.msnApi.setSession({
      sessionUser: loggedInUser,
      ecoMode: next
    })
  }

  // Auto-Hide UI após 3 segundos sem mexer o mouse no Modo Cinema (Tela 4)
  const handleCinemaMouseMove = (): void => {
    setCinemaControlsVisible(true)
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current)
    autoHideTimerRef.current = setTimeout(() => {
      setCinemaControlsVisible(false)
    }, 3000)

    if (draggingCamRef.current) {
      // atualizado no listener global
    }
  }

  // Arrastar Câmeras nos Cantos na Tela 4
  const startDraggingCornerCam = (
    target: 'my' | 'friend',
    e: React.MouseEvent<HTMLDivElement>
  ): void => {
    e.stopPropagation()
    const currentPos = target === 'my' ? myCornerCamPos : friendCornerCamPos
    draggingCamRef.current = {
      target,
      offsetX: e.clientX - currentPos.x,
      offsetY: e.clientY - currentPos.y
    }
  }

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!draggingCamRef.current) return
      const nextX = Math.max(8, Math.min(window.innerWidth - 160, e.clientX - draggingCamRef.current.offsetX))
      const nextY = Math.max(8, Math.min(window.innerHeight - 160, e.clientY - draggingCamRef.current.offsetY))
      if (draggingCamRef.current.target === 'my') {
        setMyCornerCamPos({ x: nextX, y: nextY })
      } else {
        setFriendCornerCamPos({ x: nextX, y: nextY })
      }
    }
    const onMouseUp = (): void => {
      draggingCamRef.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ==========================================================================
  // TELA 1: LOGIN RÁPIDO (SEM CADASTRO)
  // ==========================================================================
  if (!loggedInUser) {
    return (
      <div className="h-screen w-screen msn-window-bg flex flex-col justify-between p-6 select-none">
        {/* Topo Estilo Anos 2000 — Vitinho e Will */}
        <div className="flex items-center justify-between border-b border-[#8ab0d8] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#4facfe] to-[#00f2fe] border border-[#1d528d] flex items-center justify-center shadow">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-extrabold text-[#164273]">
                Vitinho e Will
              </h1>
              <p className="text-[11px] text-slate-600">
                Comunicação P2P Privada &amp; Exclusiva
              </p>
            </div>
          </div>

          <span className="px-2.5 py-1 rounded-full bg-white/80 border border-[#7da2ce] text-[11px] font-bold text-[#1d528d]">
            Ultra-Lightweight • Zero Queda de FPS
          </span>
        </div>

        {/* Cartão Central de Seleção de Usuário + PIN de 4 Dígitos */}
        <div className="max-w-md w-full mx-auto bg-white/85 backdrop-blur-xs rounded-2xl border-2 border-[#7da2ce] shadow-xl p-6 space-y-5">
          <div className="text-center space-y-1">
            <h2 className="text-base font-extrabold text-[#164273]">
              Vitinho e Will
            </h2>
            <p className="text-xs text-slate-600">
              Selecione seu perfil abaixo e digite seu PIN de 4 dígitos
            </p>
          </div>

          {/* Dois Botões Grandes Lado a Lado com Moldura de Avatar Estilo MSN */}
          <div className="grid grid-cols-2 gap-4">
            {(['Vitinho', 'Will'] as MsnUser[]).map((user) => {
              const isSelected = selectedLoginUser === user
              const avatar = user === 'Vitinho' ? AVATAR_VITINHO : AVATAR_WILL
              return (
                <button
                  key={user}
                  type="button"
                  onClick={() => {
                    setSelectedLoginUser(user)
                    setLoginError(null)
                  }}
                  className={`p-3.5 rounded-xl border-2 flex flex-col items-center gap-2 transition-all ${
                    isSelected
                      ? 'bg-gradient-to-b from-[#d9eeff] to-[#b5dcff] border-[#2664a5] shadow-md scale-[1.02]'
                      : 'bg-white/80 border-[#b0cce8] hover:border-[#6a9fd0]'
                  }`}
                >
                  <div className="msn-avatar-frame p-1.5 rounded-xl w-24 h-24">
                    <img
                      src={avatar}
                      alt={user}
                      className="w-full h-full rounded-lg object-cover"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#52b700] inline-block" />
                    <span className="text-sm font-extrabold text-[#164273]">{user}</span>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Formulário com Dropdown + PIN de 4 dígitos */}
          <form onSubmit={handleLoginSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Conta MSN (Dropdown):
                </label>
                <select
                  value={selectedLoginUser}
                  onChange={(e) => setSelectedLoginUser(e.target.value as MsnUser)}
                  className="w-full px-2.5 py-2 rounded-lg bg-white border border-[#7da2ce] text-xs font-bold text-slate-800 focus:outline-none focus:border-[#2664a5]"
                >
                  <option value="Vitinho">Vitinho (Online)</option>
                  <option value="Will">Will (Online)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  PIN de 4 Dígitos:
                </label>
                <input
                  type="password"
                  maxLength={4}
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  className="w-full px-3 py-2 rounded-lg bg-white border border-[#7da2ce] text-center tracking-[0.4em] text-sm font-extrabold text-slate-900 focus:outline-none focus:border-[#2664a5]"
                  autoFocus
                />
              </div>
            </div>

            {loginError && (
              <div className="p-2 rounded-lg bg-red-50 border border-red-300 text-[11px] text-red-700 font-semibold text-center">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-gradient-to-b from-[#4b91d1] via-[#2664a5] to-[#1d528d] hover:brightness-110 text-white font-extrabold text-xs shadow-md border border-[#143d6b]"
            >
              Entrar ({selectedLoginUser})
            </button>
          </form>
        </div>

        {/* Rodapé da Tela 1: Versão Atual + Verificar Atualização (electron-updater) */}
        <footer className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[#8ab0d8] text-xs text-slate-700">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#2664a5]" />
            <span className="font-bold">Versão atual: v{appVersion}</span>
            {updaterInfo.message && (
              <span className="text-[11px] text-[#1d528d] font-semibold">
                • {updaterInfo.message}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {updaterInfo.status === 'downloading' && (
              <div className="w-36 h-2.5 bg-white rounded-full overflow-hidden border border-[#7da2ce]">
                <div
                  className="h-full bg-[#52b700] transition-all"
                  style={{ width: `${updaterInfo.percent || 0}%` }}
                />
              </div>
            )}

            {updaterInfo.status === 'downloaded' ? (
              <button
                type="button"
                onClick={() => window.msnApi.quitAndInstallUpdate()}
                className="px-3 py-1 rounded bg-[#52b700] text-white font-bold text-xs flex items-center gap-1 shadow"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Reiniciar e Atualizar</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => window.msnApi.checkForUpdates()}
                className="msn-btn-aero px-3 py-1 rounded text-xs font-bold text-slate-800 flex items-center gap-1.5"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${
                    updaterInfo.status === 'checking' ? 'animate-spin' : ''
                  }`}
                />
                <span>Verificar Atualização</span>
              </button>
            )}
          </div>
        </footer>
      </div>
    )
  }

  const isCinemaScreenMode = inCall && roomViewActive && (isScreenSharing || remoteScreenSharing)
  const myAvatar = loggedInUser === 'Vitinho' ? AVATAR_VITINHO : AVATAR_WILL
  const friendAvatar = friendUser === 'Vitinho' ? AVATAR_VITINHO : AVATAR_WILL

  return (
    <div className="h-screen w-screen msn-window-bg flex flex-col overflow-hidden select-none">
      {/* ELEMENTO <audio id="remote-voice"> REPRODUZ A VOZ DO AMIGO NATIVAMENTE */}
      <audio id="remote-voice" ref={remoteVoiceAudioRef} autoPlay playsInline />

      {/* ELEMENTO <audio id="remote-screen-audio"> REPRODUZ O ÁUDIO DO SISTEMA/FILME NATIVAMENTE SEM ENGASGOS */}
      <audio id="remote-screen-audio" ref={remoteScreenAudioRef} autoPlay playsInline />

      {/* MODAL DE SELEÇÃO DE JANELA / TELA (desktopCapturer) */}
      <ScreenShareModal
        isOpen={screenModalOpen}
        onClose={() => setScreenModalOpen(false)}
        onSelectSource={(sourceId, includeAudio) => {
          setScreenModalOpen(false)
          webrtcRef.current?.startScreenShare(sourceId, includeAudio)
        }}
      />

      {/* MODAL DE CONFIGURAÇÃO DE MICROFONE E WEBCAM */}
      {deviceModalOpen && (
        <div
          onClick={() => setDeviceModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-2xl border-2 border-[#7da2ce] shadow-2xl overflow-hidden"
          >
            <div className="msn-header-gradient px-4 py-3 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-sky-200" />
                <span className="text-xs font-extrabold tracking-wide">
                  Configurar Microfone e Webcam
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDeviceModalOpen(false)}
                className="p-1 rounded hover:bg-white/20 text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4 text-xs text-slate-800">
              <div>
                <label className="block font-extrabold text-[#164273] mb-1">
                  🎤 Dispositivo de Microfone:
                </label>
                <select
                  value={selectedAudioDeviceId}
                  onChange={(e) => handleSelectAudioDevice(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#f4f9ff] border border-[#7da2ce] font-semibold text-slate-900 focus:outline-none focus:border-[#2664a5]"
                >
                  <option value="">Padrão do Sistema</option>
                  {audioDevices.map((dev, idx) => (
                    <option key={dev.deviceId || idx} value={dev.deviceId}>
                      {dev.label || `Microfone ${idx + 1}`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-extrabold text-[#164273] mb-1">
                  📹 Dispositivo de Webcam:
                </label>
                <select
                  value={selectedVideoDeviceId}
                  onChange={(e) => handleSelectVideoDevice(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#f4f9ff] border border-[#7da2ce] font-semibold text-slate-900 focus:outline-none focus:border-[#2664a5]"
                >
                  <option value="">Padrão do Sistema</option>
                  {videoDevices.map((dev, idx) => (
                    <option key={dev.deviceId || idx} value={dev.deviceId}>
                      {dev.label || `Webcam ${idx + 1}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => refreshMediaDevices(true)}
                  className="msn-btn-aero px-3 py-1.5 rounded-lg font-bold text-[#164273] flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-[#2664a5]" />
                  <span>Atualizar Lista</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDeviceModalOpen(false)}
                  className="px-4 py-1.5 rounded-lg bg-gradient-to-b from-[#4b91d1] to-[#1d528d] text-white font-extrabold shadow"
                >
                  Concluído
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* CABEÇALHO E SUBNICK MUSICAL (OCULTADO EM TELA CHEIA NA LIGAÇÃO)      */}
      {/* ==================================================================== */}
      {!(inCall && isCallFullscreen) && (
        <header className="msn-header-gradient px-4 py-2 text-white flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {/* Bolinha de Status do Amigo (Verde = Online, Vermelho = Ocupado, Cinza = Offline) */}
          <span
            className={`w-3.5 h-3.5 rounded-full border-2 border-white shadow shrink-0 ${
              friendStatus === 'online'
                ? 'bg-[#52b700]'
                : friendStatus === 'busy'
                  ? 'bg-[#d93025]'
                  : 'bg-[#8e99a4]'
            }`}
            title={`Status de ${friendUser}: ${friendStatus.toUpperCase()}`}
          />

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-sm tracking-wide">
                {friendUser}
              </span>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-black/25 text-sky-100 font-semibold">
                {friendStatus === 'online'
                  ? 'Online'
                  : friendStatus === 'busy'
                    ? 'Ocupado'
                    : 'Offline'}
              </span>
            </div>
            {friendSubnick && friendSubnick !== 'Offline' && (
              <div className="text-xs text-sky-100 truncate">
                {friendSubnick}
              </div>
            )}
          </div>
        </div>

        {/* Meu Status + Subnick Musical Automático */}
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 bg-black/20 px-2.5 py-1 rounded-lg border border-white/20 text-xs">
            <span className="font-bold text-sky-200">{loggedInUser}:</span>
            <select
              value={myStatus}
              onChange={(e) => setMyStatus(e.target.value as PresenceStatus)}
              className="bg-transparent text-white font-semibold focus:outline-none cursor-pointer"
            >
              <option value="online" className="text-slate-900">
                🟢 Online
              </option>
              <option value="busy" className="text-slate-900">
                🔴 Ocupado
              </option>
            </select>
            <span className="text-white/50">|</span>
            <input
              type="text"
              value={musicSubnick ? `🎵 Ouvindo: ${musicSubnick}` : customSubnick}
              disabled={Boolean(musicSubnick)}
              placeholder="Digite um recado..."
              onChange={(e) => {
                const val = e.target.value
                setCustomSubnick(val)
                window.msnApi.setSession({ sessionUser: loggedInUser, subnick: val }).catch(() => {})
              }}
              className="bg-transparent text-white placeholder-sky-200/60 text-xs w-44 truncate focus:outline-none"
              title="Seu recado/subnick (muda automaticamente quando o DJ Bot toca)"
            />
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="p-1.5 rounded hover:bg-white/20 text-white/90"
            title="Trocar de conta / Sair da sessão"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>
      )}

      {/* ==================================================================== */}
      {/* BARRA DE TOPO: OS BOTÕES GRANDES ESTILO MSN (OCULTADA EM TELA CHEIA) */}
      {/* ==================================================================== */}
      {!(inCall && isCallFullscreen) && (
        <nav className="msn-toolbar-gradient px-3 py-1.5 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 1. Entrar na Sala / Sair da Sala (Sala Sempre Existente) */}
          <button
            type="button"
            onClick={() => {
              if (inCall) {
                setRoomViewActive(false)
                setIsScreenSharing(false)
                setRemoteScreenSharing(false)
                webrtcRef.current?.rejectOrHangupCall()
              } else {
                setRoomViewActive(true)
                webrtcRef.current?.startCall(true)
              }
            }}
            className={`msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
              inCall
                ? 'text-red-700 border-red-400'
                : friendInRoom
                  ? 'ring-2 ring-[#52b700] text-[#285e00]'
                  : 'text-[#164273]'
            }`}
          >
            {inCall ? (
              <>
                <PhoneOff className="w-4 h-4 text-red-600" />
                <span>Sair da Sala</span>
              </>
            ) : (
              <>
                <Video className="w-4 h-4 text-[#2664a5]" />
                <span>
                  {friendInRoom ? `Entrar na Sala (${friendUser} está lá!)` : 'Entrar na Sala'}
                </span>
              </>
            )}
          </button>

          {/* Alternar entre Ver Sala e Ver Chat enquanto estiver dentro da Sala */}
          {inCall && (
            <button
              type="button"
              onClick={() => setRoomViewActive((prev) => !prev)}
              className="msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#164273] flex items-center gap-1.5 ring-1 ring-[#2664a5]"
            >
              <span>{roomViewActive ? '💬 Ver Chat' : '📹 Voltar para a Sala'}</span>
            </button>
          )}

          {/* 2. Compartilhar Tela */}
          <button
            type="button"
            onClick={() => {
              if (isScreenSharing) {
                webrtcRef.current?.stopScreenShare()
              } else {
                setRoomViewActive(true)
                setScreenModalOpen(true)
              }
            }}
            className={`msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
              isScreenSharing ? 'ring-2 ring-[#52b700] text-[#2b6300]' : 'text-[#164273]'
            }`}
          >
            <Monitor className="w-4 h-4 text-[#2664a5]" />
            <span>{isScreenSharing ? 'Parar Tela' : 'Compartilhar Tela'}</span>
          </button>

          {/* 3. Chamar Atenção (Nudge) com Cooldown de 5s */}
          <button
            type="button"
            onClick={handleTriggerNudge}
            disabled={nudgeCooldown > 0}
            className="msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#164273] flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            title={nudgeCooldown > 0 ? `Aguarde ${nudgeCooldown}s para chamar atenção novamente` : 'Chamar Atenção (Nudge)'}
          >
            <BellRing className="w-4 h-4 text-amber-600" />
            <span>{nudgeCooldown > 0 ? `Chamar Atenção (${nudgeCooldown}s)` : 'Chamar Atenção (Nudge)'}</span>
          </button>

          {/* 4. DJ Bot (Expande a gaveta lateral na mesma janela) */}
          <button
            type="button"
            onClick={() => setDjDrawerOpen((prev) => !prev)}
            className={`msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
              djDrawerOpen ? 'ring-2 ring-[#2664a5] bg-[#d4e9ff]' : 'text-[#164273]'
            }`}
          >
            <Disc className="w-4 h-4 text-emerald-700" />
            <span>DJ Bot {djState.isPlaying ? '🎵' : ''}</span>
          </button>

          {/* 5. Rankeador de Álbuns (Abre NOVA JANELA maior 1080x760 do Electron) */}
          <button
            type="button"
            onClick={() => window.msnApi.openAlbumRanker()}
            className="msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#164273] flex items-center gap-1.5"
          >
            <Trophy className="w-4 h-4 text-amber-500" />
            <span>Rankeador de Álbuns</span>
          </button>

          {/* 6. Configurar Microfone e Webcam */}
          <button
            type="button"
            onClick={() => {
              refreshMediaDevices(true)
              setDeviceModalOpen(true)
            }}
            className="msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#164273] flex items-center gap-1.5"
            title="Alterar dispositivo de Microfone e Webcam"
          >
            <Settings className="w-4 h-4 text-[#2664a5]" />
            <span>Mic / Webcam</span>
          </button>

          {/* 7. Modo Jogo (OFF / ON) */}
          <button
            type="button"
            onClick={handleToggleEcoMode}
            className={`msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
              ecoMode ? 'ring-2 ring-[#52b700] text-[#285e00]' : 'text-[#164273]'
            }`}
            title="Modo Jogo: economiza recursos em segundo plano mantendo a câmera fluida e sem zoom"
          >
            <Gamepad2 className="w-4 h-4 text-purple-700" />
            <span>Modo Jogo: {ecoMode ? 'ON' : 'OFF'}</span>
          </button>

          {/* 8. Verificar Atualização */}
          <button
            type="button"
            onClick={() => window.msnApi.checkForUpdates()}
            className="msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#164273] flex items-center gap-1.5"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-[#2664a5] ${
                updaterInfo.status === 'checking' ? 'animate-spin' : ''
              }`}
            />
            <span>Verificar Atualização (v{appVersion})</span>
          </button>
        </div>
      </nav>
      )}

      {/* BANNER DE STATUS DO AUTO-UPDATER NA TELA DE CHAT */}
      {updaterInfo.status !== 'idle' && (
        <div className="bg-[#eef6ff] border-b border-[#7da2ce] px-4 py-1.5 flex items-center justify-between text-xs text-[#164273]">
          <div className="flex items-center gap-2 font-bold">
            <RefreshCw
              className={`w-3.5 h-3.5 text-[#2664a5] ${
                updaterInfo.status === 'checking' || updaterInfo.status === 'downloading'
                  ? 'animate-spin'
                  : ''
              }`}
            />
            <span>{updaterInfo.message}</span>
          </div>
          <div className="flex items-center gap-2">
            {updaterInfo.status === 'downloading' && (
              <div className="w-36 h-2.5 bg-white rounded-full overflow-hidden border border-[#7da2ce]">
                <div
                  className="h-full bg-[#52b700] transition-all"
                  style={{ width: `${updaterInfo.percent || 0}%` }}
                />
              </div>
            )}
            {updaterInfo.status === 'downloaded' && (
              <button
                type="button"
                onClick={() => window.msnApi.quitAndInstallUpdate()}
                className="px-3 py-1 rounded bg-[#52b700] hover:brightness-110 text-white font-extrabold text-xs flex items-center gap-1 shadow"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Reiniciar e Instalar Atualização</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* BANNER DISCRETO QUANDO O AMIGO ESTÁ NA SALA (SEM PRECISAR ATENDER) */}
      {friendInRoom && !inCall && (
        <div className="bg-gradient-to-r from-[#1d528d] to-[#3a8d00] text-white px-4 py-1.5 flex items-center justify-between shadow-md shrink-0">
          <div className="flex items-center gap-2 text-xs font-bold">
            <span className="w-2.5 h-2.5 rounded-full bg-[#76ff03] animate-ping" />
            <span>
              🟢 {friendUser} está na Sala agora! A câmera dele aparece ali no quadrado do chat — entre quando quiser!
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setRoomViewActive(true)
              webrtcRef.current?.startCall(true)
            }}
            className="px-3 py-1 rounded-lg bg-white text-emerald-900 hover:bg-emerald-50 text-xs font-extrabold shadow flex items-center gap-1.5"
          >
            <Video className="w-3.5 h-3.5 text-emerald-700" />
            <span>Entrar na Sala</span>
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* ÁREA PRINCIPAL + GAVETA LATERAL DO DJ BOT (TELA 5)                   */}
      {/* ==================================================================== */}
      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 h-full relative">
          {/* ================================================================ */}
          {/* TELA 4: LIGAÇÃO DE VÍDEO + COMPARTILHAMENTO DE TELA (MODO CINEMA) */}
          {/* ================================================================ */}
          {isCinemaScreenMode ? (
            <div
              onMouseMove={handleCinemaMouseMove}
              className="relative w-full h-full bg-black overflow-hidden select-none cursor-default"
            >
              {/* Alerta de Saúde da Conexão / Reconexão Automática P2P */}
              {(callHealth === 'degraded' || callHealth === 'recovering') && (
                <div className="absolute top-4 left-4 z-40 px-3 py-1.5 rounded-xl bg-amber-500/95 text-slate-950 text-xs font-bold flex items-center gap-2 shadow-2xl animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-red-600 animate-ping" />
                  <span>
                    {callHealth === 'recovering'
                      ? '⚠️ Reconectando ligação P2P...'
                      : '⚠️ Conexão instável (tentando restabelecer)...'}
                  </span>
                </div>
              )}

              {/* Compartilhamento de Tela em Tela Cheia ao Fundo (Áudio gerenciado pelo remoteScreenAudioRef) */}
              <video
                id="remote-screen"
                ref={remoteScreenVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain bg-black"
              />

              {/* Câmera 1 no Canto Superior (Arrastável / Draggable): Minha Câmera Full Widescreen (sem corte quadrado) */}
              <div
                onMouseDown={(e) => startDraggingCornerCam('my', e)}
                onClick={(e) => e.stopPropagation()}
                style={{ left: myCornerCamPos.x, top: myCornerCamPos.y }}
                className="absolute z-20 w-56 aspect-video rounded-xl overflow-hidden border-2 border-[#4facfe] bg-black shadow-2xl cursor-move"
                title="Arraste para mover sua câmera para qualquer canto"
              >
                <video
                  ref={bindLocalCamRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-contain bg-black"
                />
                <span className="absolute bottom-1.5 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold">
                  {loggedInUser} (Você)
                </span>
              </div>

              {/* Câmera 2 no Canto Superior (Arrastável / Draggable): Câmera do Amigo Full Widescreen (sem corte quadrado) */}
              <div
                onMouseDown={(e) => startDraggingCornerCam('friend', e)}
                onClick={(e) => e.stopPropagation()}
                style={{ left: friendCornerCamPos.x, top: friendCornerCamPos.y }}
                className="absolute z-20 w-56 aspect-video rounded-xl overflow-hidden border-2 border-[#52b700] bg-black shadow-2xl cursor-move"
                title={`Arraste para mover a câmera de ${friendUser}`}
              >
                <video
                  ref={bindRemoteCamRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-contain bg-black"
                />
                <span className="absolute bottom-1.5 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold">
                  {friendUser}
                </span>
              </div>

              {/* Botão Rápido de Tela Cheia no Canto Superior Direito (Modo Cinema) */}
              <div
                onClick={(e) => e.stopPropagation()}
                className={`absolute top-4 right-4 z-30 transition-opacity duration-300 ${
                  cinemaControlsVisible
                    ? 'opacity-100 pointer-events-auto'
                    : 'opacity-0 pointer-events-none'
                }`}
              >
                <button
                  type="button"
                  onClick={handleToggleCallFullscreen}
                  className="px-3 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-xl transition"
                  title="Alternar Tela Cheia (F11 ou ESC)"
                >
                  {isCallFullscreen ? (
                    <>
                      <Minimize2 className="w-3.5 h-3.5 text-sky-400" />
                      Sair da Tela Cheia
                    </>
                  ) : (
                    <>
                      <Maximize2 className="w-3.5 h-3.5 text-sky-400" />
                      Tela Cheia
                    </>
                  )}
                </button>
              </div>

              {/* Barra Flutuante + Mixer de Áudio Independente (Auto-Hide após 3 segundos sem mexer o mouse) */}
              <div
                onClick={(e) => e.stopPropagation()}
                className={`absolute bottom-5 left-1/2 -translate-x-1/2 z-30 transition-opacity duration-300 ${
                  cinemaControlsVisible
                    ? 'opacity-100 pointer-events-auto'
                    : 'opacity-0 pointer-events-none'
                }`}
              >
                <div className="px-5 py-3 rounded-2xl bg-slate-950/90 backdrop-blur-md border border-slate-700 shadow-2xl flex flex-wrap items-center gap-4 text-white">
                  <button
                    type="button"
                    onClick={() => {
                      const muted = webrtcRef.current?.toggleMicrophoneMute() ?? false
                      setIsMicMuted(muted)
                      soundManager.play(muted ? 'mute' : 'unmute')
                    }}
                    className={`p-2.5 rounded-xl border ${
                      isMicMuted
                        ? 'bg-red-600/80 border-red-400'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-600'
                    }`}
                    title="Mutar / Desmutar Microfone (Ctrl+Shift+M)"
                  >
                    {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const enabled = webrtcRef.current?.toggleCameraEnabled() ?? true
                      setIsCamEnabled(enabled)
                    }}
                    className={`p-2.5 rounded-xl border ${
                      !isCamEnabled
                        ? 'bg-amber-600/80 border-amber-400'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-600'
                    }`}
                    title="Ligar / Desligar Câmera"
                  >
                    {isCamEnabled ? (
                      <Video className="w-4 h-4" />
                    ) : (
                      <VideoOff className="w-4 h-4" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      refreshMediaDevices(true)
                      setDeviceModalOpen(true)
                    }}
                    className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600"
                    title="Trocar dispositivo de Microfone ou Webcam"
                  >
                    <Settings className="w-4 h-4 text-sky-300" />
                  </button>

                  {/* Slider 1: Volume da Voz do Amigo (Boost Web Audio API até 200%) */}
                  <div className="flex items-center gap-2 px-2 border-l border-slate-700">
                    <span className="text-[11px] font-bold text-sky-300 whitespace-nowrap">
                      🎤 Voz {friendUser}:
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={friendVoiceVolume}
                      onChange={(e) => {
                        const val = Number(e.target.value)
                        setFriendVoiceVolume(val)
                        webrtcRef.current?.setRemoteVoiceBoostVolume(val)
                      }}
                      className="w-24 accent-sky-400 cursor-pointer"
                    />
                    <span className="text-[11px] font-mono w-10 text-sky-200">
                      {friendVoiceVolume}%
                    </span>
                  </div>

                  {/* Slider 2: Volume do Filme / Tela Compartilhada (0% a 100%) */}
                  <div className="flex items-center gap-2 px-2 border-l border-slate-700">
                    <Volume2 className="w-4 h-4 text-[#76ff03]" />
                    <span className="text-[11px] font-bold text-[#76ff03] whitespace-nowrap">
                      🎬 Filme/Tela:
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={screenMovieVolume}
                      onChange={(e) => setScreenMovieVolume(Number(e.target.value))}
                      className="w-24 accent-[#76ff03] cursor-pointer"
                    />
                    <span className="text-[11px] font-mono w-9 text-[#76ff03]">
                      {screenMovieVolume}%
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setDjDrawerOpen((p) => !p)}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold flex items-center gap-1.5"
                  >
                    <Disc className="w-4 h-4 text-[#76ff03]" />
                    <span>DJ Bot</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleCallFullscreen}
                    className={`px-3 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                      isCallFullscreen
                        ? 'bg-sky-600/80 border-sky-400 text-white'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-white'
                    }`}
                    title="Alternar Tela Cheia (F11 / Esc)"
                  >
                    {isCallFullscreen ? (
                      <>
                        <Minimize2 className="w-4 h-4 text-sky-200" />
                        <span>Sair da Tela Cheia</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-4 h-4 text-sky-400" />
                        <span>Tela Cheia</span>
                      </>
                    )}
                  </button>

                  {isScreenSharing && (
                    <button
                      type="button"
                      onClick={() => {
                        webrtcRef.current?.stopScreenShare()
                      }}
                      className="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg"
                      title="Parar de transmitir sua tela"
                    >
                      <MonitorOff className="w-4 h-4" />
                      <span>Parar Transmissão</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setRoomViewActive(false)
                      setIsScreenSharing(false)
                      setRemoteScreenSharing(false)
                      webrtcRef.current?.rejectOrHangupCall()
                    }}
                    className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-1.5"
                  >
                    <PhoneOff className="w-4 h-4" />
                    <span>Sair da Sala</span>
                  </button>
                </div>
              </div>
            </div>
          ) : inCall && roomViewActive ? (
            /* ================================================================ */
            /* TELA 3: SALA DE VÍDEO (1x1) — WEBCAMS SEMPRE EM IMAGEM FULL      */
            /* ================================================================ */
            <div
              onDoubleClick={handleToggleCallFullscreen}
              className="relative w-full h-full bg-slate-950 overflow-hidden flex items-center justify-center"
            >
              {/* Alerta de Saúde da Conexão / Reconexão Automática P2P */}
              {(callHealth === 'degraded' || callHealth === 'recovering') && (
                <div className="absolute top-4 left-4 z-30 px-3 py-1.5 rounded-xl bg-amber-500/95 text-slate-950 text-xs font-bold flex items-center gap-2 shadow-2xl animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-red-600 animate-ping" />
                  <span>
                    {callHealth === 'recovering'
                      ? '⚠️ Reconectando ligação P2P...'
                      : '⚠️ Conexão instável (tentando restabelecer)...'}
                  </span>
                </div>
              )}

              {/* Botões Rápidos no Canto Superior Direito (Ver Chat + Tela Cheia) */}
              <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRoomViewActive(false)}
                  className="px-3 py-1.5 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg"
                >
                  <span>💬 Ver Chat</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleCallFullscreen}
                  className="px-3 py-1.5 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg"
                  title="Alternar Tela Cheia (F11 ou Duplo Clique)"
                >
                  {isCallFullscreen ? (
                    <>
                      <Minimize2 className="w-3.5 h-3.5 text-sky-300" />
                      <span>Sair da Tela Cheia</span>
                    </>
                  ) : (
                    <>
                      <Maximize2 className="w-3.5 h-3.5 text-sky-400" />
                      <span>Tela Cheia</span>
                    </>
                  )}
                </button>
              </div>

              {/* Câmera do Amigo em proporção natural Full (object-contain) */}
              <video
                ref={bindRemoteCamRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain bg-slate-950"
              />

              {/* Aviso quando você está na Sala aguardando o amigo entrar */}
              {!friendInRoom && !hasRemoteCam && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10 p-4 text-center">
                  <div className="px-6 py-4 rounded-2xl bg-slate-900/85 border border-slate-700 shadow-2xl space-y-2 max-w-md pointer-events-auto">
                    <div className="flex items-center justify-center gap-2 text-emerald-400 font-extrabold text-sm">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#76ff03] animate-ping" />
                      <span>Você está na Sala!</span>
                    </div>
                    <p className="text-xs text-slate-300">
                      Sua webcam já está aparecendo ao vivo no quadrado do chat para <strong>{friendUser}</strong>. Assim que ele clicar em <strong>Entrar na Sala</strong>, vocês já começam a conversar!
                    </p>
                    <button
                      type="button"
                      onClick={() => setRoomViewActive(false)}
                      className="mt-1 px-4 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold shadow"
                    >
                      💬 Ir para o Chat (Continuando na Sala)
                    </button>
                  </div>
                </div>
              )}

              {/* Minha Câmera flutuando no canto inferior direito: imagem FULL da webcam sem quadrado/corte */}
              <div className="absolute bottom-20 right-5 z-20 w-64 aspect-video rounded-xl overflow-hidden border-2 border-[#4facfe] bg-black shadow-2xl">
                <video
                  ref={bindLocalCamRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-contain bg-black"
                />
                <span className="absolute bottom-1.5 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold">
                  {loggedInUser} (Você)
                </span>
              </div>

              {/* Barra de Controles Flutuante + Mixer de Voz */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-5 py-2.5 rounded-2xl bg-slate-950/90 backdrop-blur-md border border-slate-700 shadow-2xl flex items-center gap-3 text-white">
                <button
                  type="button"
                  onClick={() => {
                    const muted = webrtcRef.current?.toggleMicrophoneMute() ?? false
                    setIsMicMuted(muted)
                    soundManager.play(muted ? 'mute' : 'unmute')
                  }}
                  className={`p-2.5 rounded-xl border ${
                    isMicMuted
                      ? 'bg-red-600 border-red-400'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-600'
                  }`}
                  title="Mutar Microfone (Ctrl+Shift+M)"
                >
                  {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const enabled = webrtcRef.current?.toggleCameraEnabled() ?? true
                    setIsCamEnabled(enabled)
                  }}
                  className={`p-2.5 rounded-xl border ${
                    !isCamEnabled
                      ? 'bg-amber-600 border-amber-400'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-600'
                  }`}
                  title="Ligar / Desligar Câmera"
                >
                  {isCamEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    refreshMediaDevices(true)
                    setDeviceModalOpen(true)
                  }}
                  className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600"
                  title="Trocar dispositivo de Microfone ou Webcam"
                >
                  <Settings className="w-4 h-4 text-sky-300" />
                </button>

                <button
                  type="button"
                  onClick={() => setScreenModalOpen(true)}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold flex items-center gap-1.5"
                >
                  <Monitor className="w-4 h-4 text-sky-400" />
                  <span>Compartilhar Tela</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDjDrawerOpen((p) => !p)}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold flex items-center gap-1.5"
                >
                  <Disc className="w-4 h-4 text-[#76ff03]" />
                  <span>DJ Bot</span>
                </button>

                {/* Slider de Volume da Voz do Amigo (até 200%) */}
                <div className="flex items-center gap-2 px-2 border-l border-slate-700">
                  <Volume2 className="w-4 h-4 text-sky-400" />
                  <span className="text-[11px] font-bold text-sky-300">Voz:</span>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={friendVoiceVolume}
                    onChange={(e) => {
                      const val = Number(e.target.value)
                      setFriendVoiceVolume(val)
                      webrtcRef.current?.setRemoteVoiceBoostVolume(val)
                    }}
                    className="w-24 accent-sky-400 cursor-pointer"
                  />
                  <span className="text-[11px] font-mono w-10 text-sky-200">
                    {friendVoiceVolume}%
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleToggleCallFullscreen}
                  className={`px-3 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                    isCallFullscreen
                      ? 'bg-sky-600/80 border-sky-400 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-white'
                  }`}
                  title="Alternar Tela Cheia (F11 / Esc)"
                >
                  {isCallFullscreen ? (
                    <>
                      <Minimize2 className="w-4 h-4 text-sky-200" />
                      <span>Sair da Tela Cheia</span>
                    </>
                  ) : (
                    <>
                      <Maximize2 className="w-4 h-4 text-sky-400" />
                      <span>Tela Cheia</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setRoomViewActive(false)
                    setIsScreenSharing(false)
                    setRemoteScreenSharing(false)
                    webrtcRef.current?.rejectOrHangupCall()
                  }}
                  className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <PhoneOff className="w-4 h-4" />
                  <span>Sair da Sala</span>
                </button>
              </div>
            </div>
          ) : (
            /* ================================================================ */
            /* TELA 2: JANELA DE CONVERSA CLÁSSICA DO MSN                       */
            /* ================================================================ */
            <div className="flex-1 flex min-h-0 p-3 gap-3">
              {/* COLUNA DA ESQUERDA (CHAT + SOUNDBOARD/WINKS + INPUT/ARQUIVOS P2P) */}
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDraggingOverChat(true)
                }}
                onDragLeave={() => setIsDraggingOverChat(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setIsDraggingOverChat(false)
                  handleFilesSelected(e.dataTransfer.files)
                }}
                className={`flex-1 flex flex-col min-w-0 gap-2 relative ${
                  isDraggingOverChat ? 'ring-4 ring-[#4facfe] rounded-xl' : ''
                }`}
              >
                {/* Histórico de Mensagens ("Will diz:" / "Vitinho diz:") */}
                <div className="flex-1 bg-white rounded-xl border-2 border-[#7da2ce] shadow-inner p-3 overflow-y-auto space-y-2.5 select-text">
                  {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-xs text-slate-400 space-y-1">
                      <p className="font-bold text-slate-500">
                        Conversa privada P2P iniciada com {friendUser}.
                      </p>
                      <p>
                        Você pode colar prints da área de transferência (<strong>Ctrl+V</strong>) ou
                        arrastar qualquer arquivo sem limite de tamanho!
                      </p>
                    </div>
                  ) : (
                    messages.map((m) => {
                      if (m.isSystem) {
                        return (
                          <div
                            key={m.id}
                            className="px-3 py-1.5 rounded-lg bg-[#eef6ff] border border-[#b6d4f2] text-xs font-bold text-[#1d528d] flex items-center justify-between"
                          >
                            <span>{m.text}</span>
                            <span className="text-[10px] text-slate-400">{m.timestamp}</span>
                          </div>
                        )
                      }
                      const isMe = m.sender === loggedInUser
                      return (
                        <div key={m.id} className="space-y-0.5">
                          <div className="flex items-baseline gap-1.5">
                            <span
                              className={`text-xs font-bold ${
                                isMe ? 'text-[#1d528d]' : 'text-[#286b00]'
                              }`}
                            >
                              {m.sender} diz:
                            </span>
                            <span className="text-[10px] text-slate-400">({m.timestamp})</span>
                          </div>
                          {m.text && (
                            <p className="text-[13px] text-slate-900 pl-2 whitespace-pre-wrap break-words">
                              {m.text}
                            </p>
                          )}
                          {m.imageDataUrl && (
                            <div className="pl-2 pt-1">
                              <img
                                src={m.imageDataUrl}
                                alt="Print colado"
                                className="max-h-60 rounded-lg border border-slate-300 shadow"
                              />
                            </div>
                          )}
                          {m.fileAttachment && (
                            <div className="pl-2 pt-1">
                              <a
                                href={m.fileAttachment.blobUrl}
                                download={m.fileAttachment.fileName}
                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#e6f2ff] hover:bg-[#d2e8ff] border border-[#7da2ce] text-xs font-bold text-[#164273]"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>
                                  Baixar {m.fileAttachment.fileName} (
                                  {(m.fileAttachment.fileSize / 1024).toFixed(1)} KB)
                                </span>
                              </a>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Barra de Progresso de Transferência P2P de Arquivo */}
                {fileProgress && (
                  <div className="px-3 py-1.5 rounded-lg bg-[#dcecfc] border border-[#7da2ce] flex items-center justify-between text-xs">
                    <span className="font-bold text-[#164273] truncate">
                      {fileProgress.direction === 'sending' ? 'Enviando' : 'Recebendo'}{' '}
                      {fileProgress.fileName}...
                    </span>
                    <span className="font-extrabold text-[#2664a5]">
                      {fileProgress.percent}%
                    </span>
                  </div>
                )}

                {/* Barra Rápida de Soundboard / Winks (5 Botões de Sons Curtos Sincronizados) */}
                <div className="px-2.5 py-1.5 rounded-xl bg-[#dcecfc] border border-[#8ab0d8] flex items-center justify-between gap-1.5">
                  <span className="text-[11px] font-bold text-[#164273] shrink-0">
                    Winks / Sons:
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 flex-1">
                    {SOUNDBOARD_ITEMS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleTriggerWink(item.id, `${item.emoji} ${item.label}`)}
                        className="msn-btn-aero px-2 py-1 rounded-md text-[11px] font-bold text-slate-800 flex items-center gap-1"
                      >
                        <span>{item.emoji}</span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => handleFilesSelected(e.target.files)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="msn-btn-aero px-2.5 py-1 rounded-md text-[11px] font-bold text-[#164273] flex items-center gap-1"
                    title="Enviar Arquivo P2P sem limite de tamanho"
                  >
                    <Paperclip className="w-3.5 h-3.5" />
                    <span>Enviar Arquivo</span>
                  </button>
                </div>

                {/* Caixa de Digitação do MSN (Suporta Ctrl+V de Print) */}
                <form
                  onSubmit={handleSendText}
                  className="bg-white rounded-xl border-2 border-[#7da2ce] p-2 flex items-end gap-2 shadow-inner"
                >
                  <textarea
                    rows={2}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onPaste={handleChatPaste}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSendText(e)
                      }
                    }}
                    placeholder={`Digite uma mensagem para ${friendUser} ou pressione Ctrl+V para colar um print...`}
                    className="flex-1 resize-none text-xs text-slate-900 placeholder-slate-400 focus:outline-none p-1"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2.5 rounded-xl bg-gradient-to-b from-[#4b91d1] to-[#1d528d] hover:brightness-110 text-white font-extrabold text-xs shadow flex items-center gap-1.5 border border-[#143d6b]"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Enviar</span>
                  </button>
                </form>
              </div>

              {/* COLUNA DA DIREITA (MOLDURAS DO CHAT: MOSTRA A WEBCAM AO VIVO DE QUEM ESTIVER NA SALA!) */}
              <div className="w-52 shrink-0 flex flex-col justify-between items-center py-1">
                {/* Moldura Superior: Amigo (Mostra a Webcam Full ao vivo quando ele está na Sala!) */}
                <div className="flex flex-col items-center gap-1.5 w-full">
                  <div
                    onClick={() => {
                      if (friendInRoom && !inCall) {
                        setRoomViewActive(true)
                        webrtcRef.current?.startCall(true)
                      } else if (inCall) {
                        setRoomViewActive(true)
                      }
                    }}
                    className={`msn-avatar-frame p-1.5 rounded-2xl relative overflow-hidden transition-all ${
                      friendInRoom && hasRemoteCam
                        ? 'w-48 aspect-video cursor-pointer ring-2 ring-[#52b700]'
                        : 'w-36 h-36'
                    }`}
                    title={
                      friendInRoom
                        ? `${friendUser} está na Sala! Clique para entrar na Sala.`
                        : friendUser
                    }
                  >
                    {friendInRoom && hasRemoteCam ? (
                      <video
                        ref={bindRemoteCamRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full rounded-xl object-contain bg-black"
                      />
                    ) : (
                      <img
                        src={friendAvatar}
                        alt={friendUser}
                        className="w-full h-full rounded-xl object-cover"
                      />
                    )}
                    <span
                      className={`absolute bottom-2.5 right-2.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                        friendStatus === 'online'
                          ? 'bg-[#52b700]'
                          : friendStatus === 'busy'
                            ? 'bg-[#d93025]'
                            : 'bg-[#8e99a4]'
                      }`}
                    />
                    {friendInRoom && (
                      <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-[#3a8d00]/90 text-white text-[9px] font-extrabold shadow">
                        🟢 NA SALA
                      </span>
                    )}
                  </div>
                  <span className="text-xs font-extrabold text-[#164273]">{friendUser}</span>
                  {friendInRoom && !inCall && (
                    <button
                      type="button"
                      onClick={() => {
                        setRoomViewActive(true)
                        webrtcRef.current?.startCall(true)
                      }}
                      className="px-2.5 py-1 rounded-lg bg-[#52b700] hover:brightness-110 text-white text-[11px] font-extrabold shadow"
                    >
                      Entrar na Sala
                    </button>
                  )}
                </div>

                {/* Moldura Inferior: Você (Mostra sua Webcam Full ao vivo quando você está na Sala!) */}
                <div className="flex flex-col items-center gap-1.5 w-full">
                  <div
                    onClick={() => {
                      if (inCall) setRoomViewActive(true)
                    }}
                    className={`msn-avatar-frame p-1.5 rounded-2xl relative overflow-hidden transition-all ${
                      inCall && hasLocalCam
                        ? 'w-48 aspect-video cursor-pointer ring-2 ring-[#4facfe]'
                        : 'w-36 h-36'
                    }`}
                  >
                    {inCall && hasLocalCam ? (
                      <video
                        ref={bindLocalCamRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full rounded-xl object-contain bg-black"
                      />
                    ) : (
                      <img
                        src={myAvatar}
                        alt={loggedInUser}
                        className="w-full h-full rounded-xl object-cover"
                      />
                    )}
                    <span
                      className={`absolute bottom-2.5 right-2.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                        myStatus === 'online' ? 'bg-[#52b700]' : 'bg-[#d93025]'
                      }`}
                    />
                    {inCall && (
                      <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-[#1d528d]/90 text-white text-[9px] font-extrabold shadow">
                        🟢 NA SALA
                      </span>
                    )}
                  </div>
                  <span className="text-xs font-extrabold text-[#164273]">
                    {loggedInUser} (Você)
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ================================================================== */}
        {/* TELA 5: GAVETA LATERAL EXPANSÍVEL "DJ BOT" (ESTILO WMP 9/10)        */}
        {/* ================================================================== */}
        <DJBotDrawer
          isOpen={djDrawerOpen}
          onClose={() => setDjDrawerOpen(false)}
          currentUser={loggedInUser}
          djState={djState}
          isAnyoneSpeaking={isAnyoneSpeaking}
          onUpdateDjState={(nextState, broadcast) => {
            setDjState(nextState)
            if (broadcast) {
              webrtcRef.current?.sendDjSync(nextState)
            }
          }}
          onCurrentTrackTitleChange={(title) => {
            setMusicSubnick(title)
          }}
        />
      </div>
    </div>
  )
}
