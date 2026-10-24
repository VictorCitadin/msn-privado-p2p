import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Video,
  VideoOff,
  Monitor,
  BellRing,
  Disc,
  Trophy,
  Gamepad2,
  RefreshCw,
  Mic,
  MicOff,
  PhoneOff,
  PhoneCall,
  Send,
  Paperclip,
  Volume2,
  Sparkles,
  LogOut,
  Download,
  ShieldCheck
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
  const [customSubnick, setCustomSubnick] = useState<string>('Disponível no MSN Privado 🎮')
  const [musicSubnick, setMusicSubnick] = useState<string | null>(null)
  const [friendStatus, setFriendStatus] = useState<PresenceStatus>('offline')
  const [friendSubnick, setFriendSubnick] = useState<string>('Offline')

  const [messages, setMessages] = useState<ChatMessageItem[]>([])
  const [chatInput, setChatInput] = useState<string>('')
  const [fileProgress, setFileProgress] = useState<{
    fileName: string
    percent: number
    direction: 'sending' | 'receiving'
  } | null>(null)
  const [isDraggingOverChat, setIsDraggingOverChat] = useState<boolean>(false)

  // Estados de Chamada de Vídeo (Tela 3) e Compartilhamento de Tela Modo Cinema (Tela 4)
  const [inCall, setInCall] = useState<boolean>(false)
  const [incomingCallFrom, setIncomingCallFrom] = useState<MsnUser | null>(null)
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false)
  const [remoteScreenSharing, setRemoteScreenSharing] = useState<boolean>(false)
  const [screenModalOpen, setScreenModalOpen] = useState<boolean>(false)

  const [isMicMuted, setIsMicMuted] = useState<boolean>(false)
  const [isCamEnabled, setIsCamEnabled] = useState<boolean>(true)
  const [ecoMode, setEcoMode] = useState<boolean>(false)
  const [isWindowVisible, setIsWindowVisible] = useState<boolean>(true)

  // Mixers Independentes: Voz do Amigo (0% a 200% Boost) e Volume do Filme/Tela (0% a 100%)
  const [friendVoiceVolume, setFriendVoiceVolume] = useState<number>(100)
  const [screenMovieVolume, setScreenMovieVolume] = useState<number>(85)

  // Laser Pointer Neon Temporário (1.5s) e Auto-Hide UI (3s) na Tela 4
  const [laserPoints, setLaserPoints] = useState<LaserPointerPoint[]>([])
  const [cinemaControlsVisible, setCinemaControlsVisible] = useState<boolean>(true)
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Posições Arrastáveis (Draggable) das 2 Câmeras nos Cantos Superiores no Modo Cinema (Tela 4)
  const [myCornerCamPos, setMyCornerCamPos] = useState<{ x: number; y: number }>({
    x: 16,
    y: 16
  })
  const [friendCornerCamPos, setFriendCornerCamPos] = useState<{ x: number; y: number }>({
    x: 200,
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
  const localCamVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteCamVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const friendUser: MsnUser = loggedInUser === 'Vitinho' ? 'Will' : 'Vitinho'
  const effectiveMySubnick = musicSubnick
    ? `🎵 Ouvindo: ${musicSubnick}`
    : customSubnick

  // ==========================================================================
  // 1. CARREGAR SESSÃO SALVA, VERSÃO DO APP E EVENTOS DO ELECTRON MAIN
  // ==========================================================================
  useEffect(() => {
    window.msnApi.getAppVersion().then(setAppVersion).catch(() => {})

    window.msnApi
      .getSession()
      .then((saved) => {
        if (saved.sessionUser) {
          setLoggedInUser(saved.sessionUser)
          setSelectedLoginUser(saved.sessionUser)
        }
        if (saved.subnick) setCustomSubnick(saved.subnick)
        if (typeof saved.ecoMode === 'boolean') setEcoMode(saved.ecoMode)
      })
      .catch(() => {
        const localUser = localStorage.getItem('msn_session_user') as MsnUser | null
        if (localUser === 'Vitinho' || localUser === 'Will') {
          setLoggedInUser(localUser)
        }
      })

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

    return () => {
      unsubVisibility()
      unsubUpdater()
    }
  }, [])

  // ==========================================================================
  // 2. CONGELAMENTO DE RENDERIZAÇÃO DE VÍDEO QUANDO MINIMIZADO/OCULTO (0% GPU)
  // ==========================================================================
  const syncMediaElementsWithVisibility = useCallback(() => {
    const st = streamsRef.current

    // O <audio id="remote-voice"> SEMPRE permanece conectado mesmo minimizado durante jogos
    if (remoteVoiceAudioRef.current) {
      if (remoteVoiceAudioRef.current.srcObject !== st.remoteVoice) {
        remoteVoiceAudioRef.current.srcObject = st.remoteVoice
        remoteVoiceAudioRef.current.play().catch(() => {})
      }
    }

    // Se a janela estiver minimizada/oculta no System Tray ou em Modo Eco sem foco, desconecta o srcObject dos <video>
    if (!isWindowVisible) {
      if (localCamVideoRef.current) localCamVideoRef.current.srcObject = null
      if (remoteCamVideoRef.current) remoteCamVideoRef.current.srcObject = null
      if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null
      return
    }

    // Restaura instantaneamente ao focar/mostrar a janela
    if (localCamVideoRef.current && localCamVideoRef.current.srcObject !== st.localCam) {
      localCamVideoRef.current.srcObject = st.localCam
      localCamVideoRef.current.play().catch(() => {})
    }
    if (remoteCamVideoRef.current && remoteCamVideoRef.current.srcObject !== st.remoteCam) {
      remoteCamVideoRef.current.srcObject = st.remoteCam
      remoteCamVideoRef.current.play().catch(() => {})
    }

    const activeScreenStream = st.remoteScreen || st.localScreen
    if (
      remoteScreenVideoRef.current &&
      remoteScreenVideoRef.current.srcObject !== activeScreenStream
    ) {
      remoteScreenVideoRef.current.srcObject = activeScreenStream
      remoteScreenVideoRef.current.play().catch(() => {})
    }
  }, [isWindowVisible])

  useEffect(() => {
    syncMediaElementsWithVisibility()
  }, [
    isWindowVisible,
    inCall,
    isScreenSharing,
    remoteScreenSharing,
    syncMediaElementsWithVisibility
  ])

  // Ajusta o volume do filme/tela compartilhada (0% a 100%) e da voz do amigo
  useEffect(() => {
    if (remoteScreenVideoRef.current) {
      remoteScreenVideoRef.current.volume = Math.max(0, Math.min(1, screenMovieVolume / 100))
    }
  }, [screenMovieVolume, isScreenSharing, remoteScreenSharing])

  useEffect(() => {
    if (remoteVoiceAudioRef.current) {
      remoteVoiceAudioRef.current.volume = Math.max(0, Math.min(1, friendVoiceVolume / 100))
    }
  }, [friendVoiceVolume, inCall])

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
            'MSN Messenger Privado',
            `${loggedInUser === 'Vitinho' ? 'Will' : 'Vitinho'} acabou de entrar!`
          )
        }
      },
      onChatMessage: (msg) => {
        soundManager.play('message')
        setMessages((prev) => [...prev, msg])
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
      onLaserPointer: (point) => {
        setLaserPoints((prev) => [...prev, point])
        setTimeout(() => {
          setLaserPoints((prev) => prev.filter((p) => p.id !== point.id))
        }, 1500)
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
        setIncomingCallFrom(state.incomingCallFrom)
        setIsScreenSharing(state.isScreenSharing)
        setRemoteScreenSharing(state.remoteScreenSharing)

        if (state.incomingCallFrom) {
          soundManager.startRingLoop()
        } else {
          soundManager.stopRingLoop()
        }
      },
      onStreamsUpdated: (streams) => {
        streamsRef.current = streams
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

    return () => {
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

  // Chamar Atenção (Nudge): toca nudge.mp3 + treme a janela física do Electron por 600ms
  const handleTriggerNudge = (): void => {
    if (!loggedInUser || !webrtcRef.current) return
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

  // Alternar Modo Jogo (Eco Mode: 320x320@24fps + economia de GPU)
  const handleToggleEcoMode = async (): Promise<void> => {
    const next = !ecoMode
    setEcoMode(next)
    webrtcRef.current?.setEcoMode(next)
    await window.msnApi.setSession({
      sessionUser: loggedInUser,
      ecoMode: next
    })
  }

  // Clique no vídeo da tela compartilhada para disparar Laser Pointer Neon (1.5s)
  const handleScreenVideoClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!loggedInUser || !webrtcRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    const myPoint: LaserPointerPoint = {
      id: `local-${Date.now()}`,
      x,
      y,
      sender: loggedInUser,
      createdAt: Date.now()
    }
    setLaserPoints((prev) => [...prev, myPoint])
    setTimeout(() => {
      setLaserPoints((prev) => prev.filter((p) => p.id !== myPoint.id))
    }, 1500)

    webrtcRef.current.sendLaserPointer(x, y)
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
        {/* Topo Estilo Windows Live Messenger */}
        <div className="flex items-center justify-between border-b border-[#8ab0d8] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#4facfe] to-[#00f2fe] border border-[#1d528d] flex items-center justify-center shadow">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-extrabold text-[#164273]">
                Windows Live Messenger 2009 — Gaming Edition
              </h1>
              <p className="text-[11px] text-slate-600">
                Comunicação P2P Privada &amp; Exclusiva: Vitinho &amp; Will
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
              Entrar no MSN Messenger
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
              Entrar no Messenger ({selectedLoginUser})
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

  const isCinemaScreenMode = inCall && (isScreenSharing || remoteScreenSharing)
  const myAvatar = loggedInUser === 'Vitinho' ? AVATAR_VITINHO : AVATAR_WILL
  const friendAvatar = friendUser === 'Vitinho' ? AVATAR_VITINHO : AVATAR_WILL

  return (
    <div className="h-screen w-screen msn-window-bg flex flex-col overflow-hidden select-none">
      {/* ELEMENTO <audio id="remote-voice"> ISOLADO PARA A VOZ DO AMIGO (ZERO DUPLICAÇÃO / ZERO VOZ ROBÓTICA) */}
      <audio id="remote-voice" ref={remoteVoiceAudioRef} autoPlay playsInline />

      {/* MODAL DE SELEÇÃO DE JANELA / TELA (desktopCapturer) */}
      <ScreenShareModal
        isOpen={screenModalOpen}
        onClose={() => setScreenModalOpen(false)}
        onSelectSource={(sourceId, includeAudio) => {
          setScreenModalOpen(false)
          webrtcRef.current?.startScreenShare(sourceId, includeAudio)
        }}
      />

      {/* ==================================================================== */}
      {/* CABEÇALHO E SUBNICK MUSICAL (TELA 2)                                 */}
      {/* ==================================================================== */}
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
            <div className="text-xs text-sky-100 truncate">
              {friendSubnick}
            </div>
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
              onChange={(e) => setCustomSubnick(e.target.value)}
              className="bg-transparent text-white text-xs w-44 truncate focus:outline-none"
              title="Seu subnick no MSN (muda automaticamente quando o DJ Bot toca)"
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

      {/* ==================================================================== */}
      {/* BARRA DE TOPO: OS 7 BOTÕES GRANDES ESTILO MSN                        */}
      {/* ==================================================================== */}
      <nav className="msn-toolbar-gradient px-3 py-1.5 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 1. Ligar Vídeo */}
          <button
            type="button"
            onClick={() => {
              if (inCall) {
                webrtcRef.current?.rejectOrHangupCall()
              } else {
                soundManager.play('ring')
                webrtcRef.current?.startCall(true)
              }
            }}
            className={`msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
              inCall ? 'text-red-700 border-red-400' : 'text-[#164273]'
            }`}
          >
            {inCall ? (
              <>
                <PhoneOff className="w-4 h-4 text-red-600" />
                <span>Encerrar Ligação</span>
              </>
            ) : (
              <>
                <Video className="w-4 h-4 text-[#2664a5]" />
                <span>Ligar Vídeo</span>
              </>
            )}
          </button>

          {/* 2. Compartilhar Tela */}
          <button
            type="button"
            onClick={() => {
              if (isScreenSharing) {
                webrtcRef.current?.stopScreenShare()
              } else {
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

          {/* 3. Chamar Atenção (Nudge) */}
          <button
            type="button"
            onClick={handleTriggerNudge}
            className="msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#164273] flex items-center gap-1.5"
          >
            <BellRing className="w-4 h-4 text-amber-600" />
            <span>Chamar Atenção (Nudge)</span>
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

          {/* 6. Modo Jogo (Eco Mode) */}
          <button
            type="button"
            onClick={handleToggleEcoMode}
            className={`msn-btn-aero px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
              ecoMode ? 'ring-2 ring-[#52b700] text-[#285e00]' : 'text-[#164273]'
            }`}
            title="Reduz câmeras para 320x320@24fps e otimiza memória para zero queda de FPS"
          >
            <Gamepad2 className="w-4 h-4 text-purple-700" />
            <span>Modo Jogo {ecoMode ? '(ON)' : '(Eco)'}</span>
          </button>

          {/* 7. Verificar Atualização */}
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

      {/* ALERTA DE LIGAÇÃO RECEBIDA */}
      {incomingCallFrom && !inCall && (
        <div className="bg-gradient-to-r from-[#2664a5] to-[#52b700] text-white px-4 py-2 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-2 text-xs font-bold">
            <PhoneCall className="w-4 h-4 animate-bounce" />
            <span>{incomingCallFrom} está te ligando por vídeo no MSN!</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => webrtcRef.current?.acceptIncomingCall()}
              className="px-3 py-1 rounded bg-white text-emerald-800 text-xs font-extrabold shadow"
            >
              Atender Vídeo
            </button>
            <button
              type="button"
              onClick={() => webrtcRef.current?.rejectOrHangupCall()}
              className="px-3 py-1 rounded bg-red-600 text-white text-xs font-bold"
            >
              Recusar
            </button>
          </div>
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
              onClick={handleScreenVideoClick}
              className="relative w-full h-full bg-black overflow-hidden select-none cursor-crosshair"
            >
              {/* Compartilhamento de Tela em Tela Cheia ao Fundo */}
              <video
                id="remote-screen"
                ref={remoteScreenVideoRef}
                autoPlay
                playsInline
                muted={isScreenSharing}
                className="w-full h-full object-contain bg-black"
              />

              {/* Indicadores Neon Temporários (1.5s) do Laser Pointer */}
              {laserPoints.map((pt) => (
                <div
                  key={pt.id}
                  style={{
                    left: `${pt.x * 100}%`,
                    top: `${pt.y * 100}%`
                  }}
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 z-30"
                >
                  <div className="w-7 h-7 rounded-full bg-lime-400/40 border-2 border-[#76ff03] shadow-[0_0_18px_#76ff03] animate-ping" />
                  <span className="mt-1 px-1.5 py-0.5 rounded bg-black/80 text-[#76ff03] text-[10px] font-bold block whitespace-nowrap">
                    🎯 {pt.sender}
                  </span>
                </div>
              ))}

              {/* Câmera 1 no Canto Superior (Arrastável / Draggable): Minha Câmera (aspect-square w-36 h-36 rounded-2xl) */}
              <div
                onMouseDown={(e) => startDraggingCornerCam('my', e)}
                onClick={(e) => e.stopPropagation()}
                style={{ left: myCornerCamPos.x, top: myCornerCamPos.y }}
                className="absolute z-20 aspect-square w-36 h-36 rounded-2xl overflow-hidden border-2 border-[#4facfe] bg-slate-900 shadow-2xl cursor-move"
                title="Arraste para mover sua câmera para qualquer canto"
              >
                <video
                  ref={localCamVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <span className="absolute bottom-1.5 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold">
                  {loggedInUser} (Você)
                </span>
              </div>

              {/* Câmera 2 no Canto Superior (Arrastável / Draggable): Câmera do Amigo (aspect-square w-36 h-36 rounded-2xl) */}
              <div
                onMouseDown={(e) => startDraggingCornerCam('friend', e)}
                onClick={(e) => e.stopPropagation()}
                style={{ left: friendCornerCamPos.x, top: friendCornerCamPos.y }}
                className="absolute z-20 aspect-square w-36 h-36 rounded-2xl overflow-hidden border-2 border-[#52b700] bg-slate-900 shadow-2xl cursor-move"
                title={`Arraste para mover a câmera de ${friendUser}`}
              >
                <video
                  ref={remoteCamVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <span className="absolute bottom-1.5 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold">
                  {friendUser}
                </span>
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
                    onClick={() => webrtcRef.current?.rejectOrHangupCall()}
                    className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-1.5"
                  >
                    <PhoneOff className="w-4 h-4" />
                    <span>Desligar</span>
                  </button>
                </div>
              </div>
            </div>
          ) : inCall ? (
            /* ================================================================ */
            /* TELA 3: LIGAÇÃO DE VÍDEO (1x1)                                   */
            /* ================================================================ */
            <div className="relative w-full h-full bg-slate-950 overflow-hidden">
              {/* Câmera do Amigo ocupando 100% da área principal (w-full h-full object-cover) */}
              <video
                ref={remoteCamVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />

              {/* Minha Câmera flutuando no canto inferior direito: quadrada (aspect-square w-40 h-40) com cantos arredondados (rounded-2xl) */}
              <div className="absolute bottom-20 right-5 z-20 aspect-square w-40 h-40 rounded-2xl overflow-hidden border-2 border-[#4facfe] bg-slate-900 shadow-2xl">
                <video
                  ref={localCamVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <span className="absolute bottom-1.5 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold">
                  {loggedInUser}
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
                  onClick={() => webrtcRef.current?.rejectOrHangupCall()}
                  className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <PhoneOff className="w-4 h-4" />
                  <span>Desligar</span>
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

              {/* COLUNA DA DIREITA (AVATARES ESTILO MSN: SUPERIOR AMIGO / INFERIOR MINHA FOTO) */}
              <div className="w-40 shrink-0 flex flex-col justify-between items-center py-1">
                {/* Moldura Superior: Foto do Amigo */}
                <div className="flex flex-col items-center gap-1.5">
                  <div className="msn-avatar-frame p-2 rounded-2xl w-32 h-32 relative">
                    <img
                      src={friendAvatar}
                      alt={friendUser}
                      className="w-full h-full rounded-xl object-cover"
                    />
                    <span
                      className={`absolute bottom-2.5 right-2.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                        friendStatus === 'online'
                          ? 'bg-[#52b700]'
                          : friendStatus === 'busy'
                            ? 'bg-[#d93025]'
                            : 'bg-[#8e99a4]'
                      }`}
                    />
                  </div>
                  <span className="text-xs font-extrabold text-[#164273]">{friendUser}</span>
                </div>

                {/* Moldura Inferior: Minha Foto */}
                <div className="flex flex-col items-center gap-1.5">
                  <div className="msn-avatar-frame p-2 rounded-2xl w-32 h-32 relative">
                    <img
                      src={myAvatar}
                      alt={loggedInUser}
                      className="w-full h-full rounded-xl object-cover"
                    />
                    <span
                      className={`absolute bottom-2.5 right-2.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                        myStatus === 'online' ? 'bg-[#52b700]' : 'bg-[#d93025]'
                      }`}
                    />
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
