import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BellRing,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  SwitchCamera,
  Video,
  VideoOff,
  Download,
  Maximize2,
  Minimize2,
  Eye,
  EyeOff
} from 'lucide-react'
import {
  ALL_USERS,
  ChatMessageItem,
  MsnUser,
  MsnWebRTCService,
  PresenceStatus,
  RemotePeerStreams,
  sharesChatHistory
} from '../renderer/src/services/webrtc'
import { soundManager } from '../renderer/src/services/soundManager'
import { USER_AVATARS, USER_COLORS, joinNames } from '../renderer/src/services/avatars'
import { EXIT_FULLSCREEN_EVENT, enterImmersive, exitImmersive, setKeepAwake } from './immersive'

/**
 * Vitinho e Will — app do tablet (Android).
 * Versão simplificada: login de qualquer perfil, chat em grupo e ligação (voz, câmera e assistir
 * telas compartilhadas). Sem DJ Bot, Rankeador ou compartilhamento de tela.
 */

const SESSION_KEY = 'vw_mobile_session_user'
const MESSAGES_KEY_PREFIX = 'vw_mobile_messages_'
const MAX_STORED_MESSAGES = 200

const PINS: Record<MsnUser, string> = {
  Vitinho: import.meta.env.VITE_PIN_VITINHO || '1234',
  Will: import.meta.env.VITE_PIN_WILL || '4321',
  Nath: import.meta.env.VITE_PIN_NATH || '2468'
}

// Destaque da aba ativa: estilo inline porque as classes msn-* têm precedência sobre o Tailwind
const ACTIVE_TAB_STYLE: React.CSSProperties = {
  background: 'linear-gradient(180deg, #e3f0ff 0%, #bcd9f7 100%)',
  borderColor: '#2664a5',
  boxShadow: 'inset 0 0 0 2px #2664a5'
}
const ROOM_ALERT_TAB_STYLE: React.CSSProperties = { boxShadow: 'inset 0 0 0 2px #52b700' }

const nowTimeLabel = (): string =>
  new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function loadStoredMessages(user: MsnUser): ChatMessageItem[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY_PREFIX + user)
    const parsed = raw ? (JSON.parse(raw) as ChatMessageItem[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveStoredMessages(user: MsnUser, messages: ChatMessageItem[]): void {
  try {
    // Anexos de arquivo usam blob: URLs que não sobrevivem a reiniciar o app
    const clean = messages.slice(-MAX_STORED_MESSAGES).map((m) => ({ ...m, fileAttachment: undefined }))
    localStorage.setItem(MESSAGES_KEY_PREFIX + user, JSON.stringify(clean))
  } catch {
    // armazenamento cheio (muitas imagens): mantém só as mais recentes sem imagem
    try {
      const slim = messages.slice(-60).map((m) => ({ ...m, imageDataUrl: undefined, fileAttachment: undefined }))
      localStorage.setItem(MESSAGES_KEY_PREFIX + user, JSON.stringify(slim))
    } catch {}
  }
}

export function MobileApp(): React.ReactElement {
  const [user, setUser] = useState<MsnUser | null>(() => {
    try {
      const saved = localStorage.getItem(SESSION_KEY) as MsnUser | null
      return saved && ALL_USERS.includes(saved) ? saved : null
    } catch {
      return null
    }
  })

  if (!user) {
    return (
      <LoginScreen
        onLogin={(u) => {
          try {
            localStorage.setItem(SESSION_KEY, u)
          } catch {}
          soundManager.play('login')
          setUser(u)
        }}
      />
    )
  }

  return (
    <MessengerScreen
      key={user}
      user={user}
      onLogout={() => {
        try {
          localStorage.removeItem(SESSION_KEY)
        } catch {}
        setUser(null)
      }}
    />
  )
}

// ============================================================================
// LOGIN
// ============================================================================
const LoginScreen: React.FC<{ onLogin: (user: MsnUser) => void }> = ({ onLogin }) => {
  const [selected, setSelected] = useState<MsnUser>('Nath')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (pin.trim() !== PINS[selected]) {
      setError(`PIN incorreto para ${selected}.`)
      return
    }
    setError(null)
    onLogin(selected)
  }

  return (
    <div className="min-h-screen msn-window-bg flex flex-col items-center justify-center p-6 select-none">
      <div className="w-full max-w-lg bg-white/90 rounded-3xl border-2 border-[#7da2ce] shadow-2xl p-6 space-y-5">
        <div className="text-center">
          <h1 className="text-xl font-extrabold text-[#164273]">Vitinho e Will</h1>
          <p className="text-sm text-slate-600">Escolha seu perfil e digite o PIN</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {ALL_USERS.map((u) => {
            const isSel = selected === u
            return (
              <button
                key={u}
                type="button"
                onClick={() => {
                  setSelected(u)
                  setError(null)
                }}
                className={`p-2.5 rounded-2xl border-2 flex flex-col items-center gap-1.5 transition-all ${
                  isSel ? 'bg-[#e8f3fd] scale-[1.03] shadow-md' : 'bg-white border-[#b0cce8]'
                }`}
                style={isSel ? { borderColor: USER_COLORS[u].hex } : undefined}
              >
                <img src={USER_AVATARS[u]} alt={u} className="w-full aspect-square rounded-xl" />
                <span className={`text-sm font-extrabold ${USER_COLORS[u].text}`}>{u}</span>
              </button>
            )
          })}
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="PIN de 4 dígitos"
            className="w-full px-4 py-3 rounded-xl bg-white border-2 border-[#7da2ce] text-center tracking-[0.5em] text-lg font-extrabold text-slate-900 focus:outline-none focus:border-[#2664a5]"
            autoFocus
          />
          {error && (
            <div className="p-2 rounded-lg bg-red-50 border border-red-300 text-sm text-red-700 font-semibold text-center">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-gradient-to-b from-[#4b91d1] via-[#2664a5] to-[#1d528d] text-white font-extrabold text-base shadow-md border border-[#143d6b]"
          >
            Entrar como {selected}
          </button>
        </form>
      </div>
    </div>
  )
}

// ============================================================================
// MESSENGER (CHAT + SALA)
// ============================================================================
type Presence = Record<MsnUser, { status: PresenceStatus; subnick: string }>

const MessengerScreen: React.FC<{ user: MsnUser; onLogout: () => void }> = ({ user, onLogout }) => {
  const friends = useMemo(() => ALL_USERS.filter((u) => u !== user), [user])
  const [tab, setTab] = useState<'chat' | 'room'>('chat')
  const [presence, setPresence] = useState<Presence>({
    Vitinho: { status: 'offline', subnick: '' },
    Will: { status: 'offline', subnick: '' },
    Nath: { status: 'offline', subnick: '' }
  })
  const [messages, setMessages] = useState<ChatMessageItem[]>(() => loadStoredMessages(user))
  const messagesRef = useRef<ChatMessageItem[]>(messages)
  const [chatInput, setChatInput] = useState('')
  const [unread, setUnread] = useState(0)
  const [shaking, setShaking] = useState(false)

  const [inCall, setInCall] = useState(false)
  const [friendsInRoom, setFriendsInRoom] = useState<MsnUser[]>([])
  const [remoteScreenSharer, setRemoteScreenSharer] = useState<MsnUser | null>(null)
  const [callHealth, setCallHealth] = useState<string>('connecting')
  const [isMicMuted, setIsMicMuted] = useState(false)
  const [isCamEnabled, setIsCamEnabled] = useState(true)
  const [streamsVersion, setStreamsVersion] = useState(0)
  // Tela cheia da sala (filmes no compartilhamento de tela): esconde toda a interface do app
  const [fullscreen, setFullscreen] = useState(false)

  const serviceRef = useRef<MsnWebRTCService | null>(null)
  const streamsRef = useRef<{
    localCam: MediaStream | null
    remotes: Partial<Record<MsnUser, RemotePeerStreams>>
  }>({ localCam: null, remotes: {} })
  const tabRef = useRef(tab)
  tabRef.current = tab
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const appendSystem = useCallback(
    (text: string, sender: MsnUser = user) => {
      setMessages((prev) => [
        ...prev,
        { id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sender, text, isSystem: true, timestamp: nowTimeLabel() }
      ])
    },
    [user]
  )

  // Persistência local do histórico
  useEffect(() => {
    messagesRef.current = messages
    saveStoredMessages(user, messages)
  }, [messages, user])

  useEffect(() => {
    if (tab === 'chat') {
      setUnread(0)
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, tab])

  // Serviço WebRTC (mesmo motor do app de PC)
  useEffect(() => {
    const service = new MsnWebRTCService(user, {
      onFriendPresenceChange: (friend, status, subnick, justLoggedIn) => {
        setPresence((prev) =>
          prev[friend].status === status && prev[friend].subnick === subnick
            ? prev
            : { ...prev, [friend]: { status, subnick } }
        )
        if (justLoggedIn) soundManager.play('login')
      },
      onChatMessage: (msg) => {
        soundManager.play('message')
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
        if (tabRef.current !== 'chat') setUnread((n) => n + 1)
      },
      onChatHistorySync: (sender, remoteMsgs) => {
        if (!sharesChatHistory(user, sender)) return
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id))
          const missing = remoteMsgs.filter((m) => m?.id && !ids.has(m.id))
          return missing.length ? [...prev, ...missing].slice(-MAX_STORED_MESSAGES) : prev
        })
      },
      onDataChannelOpen: (friend) => {
        if (messagesRef.current.length > 0 && sharesChatHistory(user, friend)) {
          service.sendChatHistorySync(friend, messagesRef.current)
        }
      },
      onNudgeReceived: (sender) => {
        soundManager.play('nudge')
        navigator.vibrate?.([200, 100, 200, 100, 300])
        setShaking(true)
        setTimeout(() => setShaking(false), 650)
        appendSystem(`🔔 ${sender} chamou sua atenção!`, sender)
      },
      onSoundboardWink: (sender, winkId, label) => {
        soundManager.playSoundboardWink(winkId)
        appendSystem(`🔊 ${sender} enviou um Wink sonoro: ${label}`, sender)
      },
      onDjSync: () => {
        // DJ Bot existe só no app de PC
      },
      onAlbumRankedNotification: (p) => {
        appendSystem(`🏆 ${p.user} rankeou o álbum "${p.albumName}" com nota ${p.rating.toFixed(1)}/5.0`, p.user)
      },
      onCallStateChange: (state) => {
        setInCall(state.inCall)
        setCallHealth(state.callHealth)
        setFriendsInRoom((prev) =>
          prev.length === state.friendsInRoom.length && prev.every((f) => state.friendsInRoom.includes(f))
            ? prev
            : state.friendsInRoom
        )
        setRemoteScreenSharer(state.remoteScreenSharer)
      },
      onCallDropped: (reason) => {
        soundManager.play('room-leave')
        appendSystem(`⚠️ A ligação caiu (${reason}).`)
      },
      onFriendDroppedFromCall: (friend, reason) => {
        appendSystem(`⚠️ ${friend} caiu da ligação (${reason}).`, friend)
      },
      onStreamsUpdated: (streams) => {
        streamsRef.current = { localCam: streams.localCam, remotes: streams.remotes }
        setStreamsVersion((v) => v + 1)
      },
      onVoiceActivityChange: () => {},
      onFileProgress: () => {}
    })
    serviceRef.current = service

    const resumeAudio = (): void => service.resumeAudioContext()
    window.addEventListener('touchstart', resumeAudio, { once: true })
    window.addEventListener('click', resumeAudio, { once: true })
    const onUnload = (): void => service.destroy()
    window.addEventListener('beforeunload', onUnload)

    return () => {
      window.removeEventListener('beforeunload', onUnload)
      service.destroy()
      serviceRef.current = null
    }
  }, [user, appendSystem])

  // Sons de entrada/saída na sala
  const prevRoomCount = useRef(0)
  const prevInCall = useRef(false)
  useEffect(() => {
    const count = friendsInRoom.length
    if ((!prevInCall.current && inCall) || count > prevRoomCount.current) soundManager.play('room-join')
    else if ((prevInCall.current && !inCall) || count < prevRoomCount.current) soundManager.play('room-leave')
    prevRoomCount.current = count
    prevInCall.current = inCall
    if (!inCall) {
      setIsMicMuted(false)
      setIsCamEnabled(true)
      setFullscreen(false)
    }
    // Tela acesa durante a ligação: com a tela apagada o Android pode derrubar a chamada
    setKeepAwake(inCall)
  }, [friendsInRoom.length, inCall])

  // Tela cheia real (esconde as barras do Android) e botão voltar saindo da tela cheia
  useEffect(() => {
    if (fullscreen) {
      enterImmersive()
    } else {
      exitImmersive()
    }
  }, [fullscreen])

  useEffect(() => {
    const onBack = (): void => setFullscreen(false)
    window.addEventListener(EXIT_FULLSCREEN_EVENT, onBack)
    return () => {
      window.removeEventListener(EXIT_FULLSCREEN_EVENT, onBack)
      exitImmersive()
      setKeepAwake(false)
    }
  }, [])

  const sendText = (e?: React.FormEvent): void => {
    e?.preventDefault()
    const text = chatInput.trim()
    if (!text || !serviceRef.current) return
    const msg = serviceRef.current.sendChatMessage(text)
    setMessages((prev) => [...prev, msg])
    setChatInput('')
  }

  const sendNudge = (): void => {
    serviceRef.current?.sendNudge()
    soundManager.play('nudge')
    navigator.vibrate?.(150)
    const online = friends.filter((f) => presence[f].status !== 'offline')
    appendSystem(`🔔 Você chamou a atenção de ${joinNames(online.length ? online : friends)}!`)
  }

  const onlineFriends = friends.filter((f) => presence[f].status !== 'offline')
  const roomLabel = joinNames(friendsInRoom)

  // Vozes dos amigos (um <audio> por pessoa) e áudio da tela compartilhada
  const mediaSinks = (
    <MediaSinks
      friends={friends}
      inCall={inCall}
      remoteScreenSharer={remoteScreenSharer}
      streamsRef={streamsRef}
      version={streamsVersion}
    />
  )

  const roomView = (
    <RoomView
      user={user}
      inCall={inCall}
      friendsInRoom={friendsInRoom}
      remoteScreenSharer={remoteScreenSharer}
      callHealth={callHealth}
      streamsRef={streamsRef}
      version={streamsVersion}
      isMicMuted={isMicMuted}
      isCamEnabled={isCamEnabled}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((v) => !v)}
      onEnter={() => serviceRef.current?.startCall(true)}
      onLeave={() => serviceRef.current?.rejectOrHangupCall()}
      onToggleMic={() => {
        const muted = serviceRef.current?.toggleMicrophoneMute() ?? false
        setIsMicMuted(muted)
        soundManager.play(muted ? 'mute' : 'unmute')
      }}
      onToggleCam={async () => {
        const enabled = (await serviceRef.current?.toggleCameraEnabled()) ?? true
        setIsCamEnabled(enabled)
      }}
      onSwitchCamera={() => {
        serviceRef.current?.switchToNextCamera().catch(() => {})
      }}
    />
  )

  if (fullscreen && inCall) {
    return (
      <div className={`h-screen w-screen bg-black overflow-hidden select-none ${shaking ? 'mobile-nudge' : ''}`}>
        {mediaSinks}
        {roomView}
      </div>
    )
  }

  return (
    <div className={`h-screen w-screen msn-window-bg flex flex-col overflow-hidden select-none ${shaking ? 'mobile-nudge' : ''}`}>
      {mediaSinks}

      {/* CABEÇALHO */}
      <header className="msn-header-gradient px-4 py-2.5 text-white flex items-center justify-between shrink-0 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3 min-w-0">
          <img src={USER_AVATARS[user]} alt={user} className="w-10 h-10 rounded-xl border-2 border-white/70" />
          <div className="min-w-0">
            <div className="font-extrabold text-base leading-tight">{user}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {friends.map((f) => (
                <span key={f} className="flex items-center gap-1">
                  <span
                    className={`w-2.5 h-2.5 rounded-full border border-white ${
                      presence[f].status === 'online'
                        ? 'bg-[#52b700]'
                        : presence[f].status === 'busy'
                          ? 'bg-[#d93025]'
                          : 'bg-[#8e99a4]'
                    }`}
                  />
                  <span className="font-semibold">{f}</span>
                  {friendsInRoom.includes(f) && <span className="text-[10px] text-lime-200">(na sala)</span>}
                </span>
              ))}
            </div>
          </div>
        </div>
        <button type="button" onClick={onLogout} className="p-2 rounded-lg hover:bg-white/20" title="Sair da conta">
          <LogOut className="w-5 h-5" />
        </button>
      </header>

      {/* ABAS */}
      <nav className="msn-toolbar-gradient px-3 py-2 flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => setTab('chat')}
          style={tab === 'chat' ? ACTIVE_TAB_STYLE : undefined}
          className={`msn-btn-aero flex-1 py-2.5 rounded-xl text-sm font-extrabold flex items-center justify-center gap-2 ${
            tab === 'chat' ? 'text-[#164273]' : 'text-slate-600'
          }`}
        >
          <MessageCircle className="w-4 h-4" />
          Chat
          {unread > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] leading-none">{unread}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab('room')}
          style={
            tab === 'room'
              ? ACTIVE_TAB_STYLE
              : !inCall && friendsInRoom.length > 0
                ? ROOM_ALERT_TAB_STYLE
                : undefined
          }
          className={`msn-btn-aero flex-1 py-2.5 rounded-xl text-sm font-extrabold flex items-center justify-center gap-2 ${
            tab === 'room' ? 'text-[#164273]' : 'text-slate-600'
          }`}
        >
          <Video className="w-4 h-4" />
          {inCall ? 'Sala (você está)' : friendsInRoom.length > 0 ? `Sala (${roomLabel})` : 'Sala'}
        </button>
      </nav>

      {tab === 'chat' ? (
        <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
          <div className="flex-1 bg-white rounded-2xl border-2 border-[#7da2ce] shadow-inner p-3 overflow-y-auto space-y-2.5 select-text">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-center text-sm text-slate-400 px-6">
                Conversa P2P com {joinNames(onlineFriends.length ? onlineFriends : friends)}. As mensagens só chegam
                para quem estiver online.
              </div>
            ) : (
              messages.map((m) =>
                m.isSystem ? (
                  <div
                    key={m.id}
                    className="px-3 py-1.5 rounded-lg bg-[#eef6ff] border border-[#b6d4f2] text-xs font-bold text-[#1d528d] flex items-center justify-between gap-2"
                  >
                    <span>{m.text}</span>
                    <span className="text-[10px] text-slate-400 shrink-0">{m.timestamp}</span>
                  </div>
                ) : (
                  <div key={m.id} className="space-y-0.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-sm font-bold ${USER_COLORS[m.sender]?.text || 'text-slate-700'}`}>
                        {m.sender === user ? 'Você' : m.sender} diz:
                      </span>
                      <span className="text-[10px] text-slate-400">({m.timestamp})</span>
                    </div>
                    {m.text && <p className="text-[15px] text-slate-900 pl-2 whitespace-pre-wrap break-words">{m.text}</p>}
                    {m.imageDataUrl && (
                      <img src={m.imageDataUrl} alt="Imagem" className="ml-2 max-h-72 rounded-lg border border-slate-300 shadow" />
                    )}
                    {m.fileAttachment && (
                      <a
                        href={m.fileAttachment.blobUrl}
                        download={m.fileAttachment.fileName}
                        className="ml-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#e6f2ff] border border-[#7da2ce] text-xs font-bold text-[#164273]"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {m.fileAttachment.fileName} ({(m.fileAttachment.fileSize / 1024).toFixed(0)} KB)
                      </a>
                    )}
                  </div>
                )
              )
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            onSubmit={sendText}
            className="bg-white rounded-2xl border-2 border-[#7da2ce] p-2 flex items-end gap-2 shadow-inner pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          >
            <button
              type="button"
              onClick={sendNudge}
              className="msn-btn-aero p-3 rounded-xl text-amber-600 shrink-0"
              title="Chamar atenção"
            >
              <BellRing className="w-5 h-5" />
            </button>
            <textarea
              rows={1}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendText()
                }
              }}
              placeholder="Digite uma mensagem..."
              className="flex-1 resize-none text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none p-2"
            />
            <button
              type="submit"
              className="px-4 py-3 rounded-xl bg-gradient-to-b from-[#4b91d1] to-[#1d528d] text-white font-extrabold text-sm shadow flex items-center gap-1.5 shrink-0"
            >
              <Send className="w-4 h-4" />
              Enviar
            </button>
          </form>
        </div>
      ) : (
        roomView
      )}
    </div>
  )
}

// ============================================================================
// ÁUDIO: vozes dos amigos e som da tela compartilhada
// ============================================================================
const MediaSinks: React.FC<{
  friends: MsnUser[]
  inCall: boolean
  remoteScreenSharer: MsnUser | null
  streamsRef: React.MutableRefObject<{ remotes: Partial<Record<MsnUser, RemotePeerStreams>> }>
  version: number
}> = ({ friends, inCall, remoteScreenSharer, streamsRef, version }) => {
  const voiceRefs = useRef<Partial<Record<MsnUser, HTMLAudioElement | null>>>({})
  const screenAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const remotes = streamsRef.current.remotes
    for (const f of friends) {
      const el = voiceRefs.current[f]
      if (!el) continue
      const voice = remotes[f]?.voice || null
      el.muted = !inCall
      if (el.srcObject !== voice) el.srcObject = voice
      if (inCall && voice && el.paused) el.play().catch(() => {})
    }
    const screenEl = screenAudioRef.current
    if (screenEl) {
      const screen = remoteScreenSharer ? remotes[remoteScreenSharer]?.screen || null : null
      const hasAudio = Boolean(screen && screen.getAudioTracks().length > 0)
      const target = inCall && hasAudio ? screen : null
      if (screenEl.srcObject !== target) screenEl.srcObject = target
      if (target && screenEl.paused) screenEl.play().catch(() => {})
    }
  }, [friends, inCall, remoteScreenSharer, streamsRef, version])

  return (
    <>
      {friends.map((f) => (
        <audio
          key={f}
          ref={(el) => {
            voiceRefs.current[f] = el
          }}
          autoPlay
          playsInline
        />
      ))}
      <audio ref={screenAudioRef} autoPlay playsInline />
    </>
  )
}

// ============================================================================
// SALA (LIGAÇÃO)
// ============================================================================
const StreamVideo: React.FC<{
  stream: MediaStream | null
  className?: string
  mirrored?: boolean
}> = ({ stream, className, mirrored }) => {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    if (stream) el.play().catch(() => {})
  }, [stream])
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={className}
      style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
    />
  )
}

const RoomView: React.FC<{
  user: MsnUser
  inCall: boolean
  friendsInRoom: MsnUser[]
  remoteScreenSharer: MsnUser | null
  callHealth: string
  streamsRef: React.MutableRefObject<{
    localCam: MediaStream | null
    remotes: Partial<Record<MsnUser, RemotePeerStreams>>
  }>
  version: number
  isMicMuted: boolean
  isCamEnabled: boolean
  fullscreen: boolean
  onToggleFullscreen: () => void
  onEnter: () => void
  onLeave: () => void
  onToggleMic: () => void
  onToggleCam: () => void
  onSwitchCamera: () => void
}> = (props) => {
  const { user, inCall, friendsInRoom, remoteScreenSharer, callHealth, streamsRef } = props
  void props.version // re-render quando os streams mudam
  const remotes = streamsRef.current.remotes
  const screen = remoteScreenSharer ? remotes[remoteScreenSharer]?.screen || null : null
  const showScreen = inCall && Boolean(screen && screen.getVideoTracks().length > 0)

  if (!inCall) {
    // Fora da sala: mostra quem está lá (com a câmera ao vivo) e o botão de entrar
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6 text-center">
        {friendsInRoom.length > 0 ? (
          <>
            <div className="text-lg font-extrabold text-[#164273]">
              🟢 {joinNames(friendsInRoom)} {friendsInRoom.length > 1 ? 'estão' : 'está'} na Sala!
            </div>
            <div className={`grid gap-3 w-full max-w-3xl ${friendsInRoom.length > 1 ? 'grid-cols-2' : 'grid-cols-1 max-w-xl'}`}>
              {friendsInRoom.map((f) => (
                <div
                  key={f}
                  className="relative aspect-video rounded-2xl overflow-hidden bg-black border-2"
                  style={{ borderColor: USER_COLORS[f].hex }}
                >
                  <StreamVideo stream={remotes[f]?.cam || null} className="w-full h-full object-contain" />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-xs font-bold">{f}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-base font-bold text-slate-600">Ninguém está na Sala agora.</div>
        )}
        <button
          type="button"
          onClick={props.onEnter}
          className="px-8 py-4 rounded-2xl bg-gradient-to-b from-[#52b700] to-[#347800] text-white text-lg font-extrabold shadow-lg border border-[#2d6600] flex items-center gap-2"
        >
          <Video className="w-6 h-6" />
          Entrar na Sala
        </button>
      </div>
    )
  }

  if (props.fullscreen) {
    return <FullscreenRoom {...props} screen={showScreen ? screen : null} />
  }

  return (
    <div className="flex-1 relative bg-slate-950 overflow-hidden flex flex-col">
      {(callHealth === 'degraded' || callHealth === 'recovering') && (
        <div className="absolute top-3 left-3 z-30 px-3 py-1.5 rounded-xl bg-amber-500/95 text-slate-950 text-xs font-bold shadow-xl">
          {callHealth === 'recovering' ? '⚠️ Reconectando...' : '⚠️ Conexão instável...'}
        </div>
      )}

      <div className="flex-1 min-h-0 p-2 flex flex-col gap-2">
        {showScreen && (
          <div
            className="flex-[3] min-h-0 relative rounded-xl overflow-hidden bg-black"
            onDoubleClick={props.onToggleFullscreen}
          >
            <StreamVideo stream={screen} className="w-full h-full object-contain" />
            <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-xs font-bold">
              🖥️ Tela de {remoteScreenSharer}
            </span>
            <button
              type="button"
              onClick={props.onToggleFullscreen}
              className="absolute top-2 right-2 px-3 py-2 rounded-xl bg-black/70 border border-white/30 text-white text-sm font-bold flex items-center gap-1.5"
            >
              <Maximize2 className="w-4 h-4" />
              Tela cheia
            </button>
          </div>
        )}

        <div className={`${showScreen ? 'flex-1' : 'flex-1'} min-h-0 grid gap-2 ${friendsInRoom.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {friendsInRoom.length === 0 ? (
            <div className="flex items-center justify-center text-slate-300 text-sm font-semibold text-center px-6">
              Você está na Sala! Assim que alguém entrar, a câmera aparece aqui.
            </div>
          ) : (
            friendsInRoom.map((f) => (
              <div key={f} className="relative rounded-xl overflow-hidden bg-black border-2" style={{ borderColor: USER_COLORS[f].hex }}>
                <StreamVideo stream={remotes[f]?.cam || null} className="w-full h-full object-contain" />
                <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-xs font-bold">{f}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Minha câmera */}
      <div
        className="absolute bottom-24 right-3 z-20 w-40 aspect-video rounded-xl overflow-hidden border-2 bg-black shadow-2xl"
        style={{ borderColor: USER_COLORS[user].hex }}
      >
        <StreamVideo stream={streamsRef.current.localCam} className="w-full h-full object-cover" mirrored />
        {!props.isCamEnabled && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white text-xs font-bold">Câmera desligada</div>
        )}
      </div>

      {/* Controles */}
      <div className="shrink-0 px-4 py-3 bg-slate-900/95 border-t border-slate-700 flex items-center justify-center gap-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={props.onToggleMic}
          className={`p-4 rounded-2xl border text-white ${props.isMicMuted ? 'bg-red-600 border-red-400' : 'bg-slate-800 border-slate-600'}`}
          title="Mutar / desmutar microfone"
        >
          {props.isMicMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>
        <button
          type="button"
          onClick={props.onToggleCam}
          className={`p-4 rounded-2xl border text-white ${!props.isCamEnabled ? 'bg-amber-600 border-amber-400' : 'bg-slate-800 border-slate-600'}`}
          title="Ligar / desligar câmera"
        >
          {props.isCamEnabled ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
        </button>
        <button
          type="button"
          onClick={props.onSwitchCamera}
          className="p-4 rounded-2xl border bg-slate-800 border-slate-600 text-white"
          title="Trocar câmera (frontal / traseira)"
        >
          <SwitchCamera className="w-6 h-6" />
        </button>
        <button
          type="button"
          onClick={props.onToggleFullscreen}
          className="p-4 rounded-2xl border bg-slate-800 border-slate-600 text-white"
          title="Tela cheia"
        >
          <Maximize2 className="w-6 h-6" />
        </button>
        <button
          type="button"
          onClick={props.onLeave}
          className="px-6 py-4 rounded-2xl bg-red-600 border border-red-400 text-white font-extrabold flex items-center gap-2"
        >
          <PhoneOff className="w-6 h-6" />
          Sair
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// SALA EM TELA CHEIA (FILMES): tela compartilhada ocupando tudo + câmeras pequenas no canto
// ============================================================================
const FULLSCREEN_CONTROLS_HIDE_MS = 4000

const FullscreenRoom: React.FC<{
  user: MsnUser
  friendsInRoom: MsnUser[]
  remoteScreenSharer: MsnUser | null
  callHealth: string
  streamsRef: React.MutableRefObject<{
    localCam: MediaStream | null
    remotes: Partial<Record<MsnUser, RemotePeerStreams>>
  }>
  screen: MediaStream | null
  isMicMuted: boolean
  isCamEnabled: boolean
  onToggleFullscreen: () => void
  onLeave: () => void
  onToggleMic: () => void
}> = (props) => {
  const { user, friendsInRoom, remoteScreenSharer, callHealth, streamsRef, screen } = props
  const remotes = streamsRef.current.remotes
  const [camsVisible, setCamsVisible] = useState(true)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), FULLSCREEN_CONTROLS_HIDE_MS)
  }, [])

  useEffect(() => {
    showControls()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [showControls])

  // Toque na tela: mostra/esconde os controles
  const handleTap = (): void => {
    if (controlsVisible) {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setControlsVisible(false)
    } else {
      showControls()
    }
  }

  // Botões reiniciam o tempo para esconder e não repassam o toque para a tela
  const action = (fn: () => void) => (e: React.MouseEvent): void => {
    e.stopPropagation()
    fn()
    showControls()
  }

  const fade = controlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
  const camTiles: Array<{ key: string; label: string; stream: MediaStream | null; color: string; mine: boolean }> = [
    ...friendsInRoom.map((f) => ({
      key: f,
      label: f,
      stream: remotes[f]?.cam || null,
      color: USER_COLORS[f].hex,
      mine: false
    })),
    { key: 'me', label: 'Você', stream: streamsRef.current.localCam, color: USER_COLORS[user].hex, mine: true }
  ]

  return (
    <div className="fixed inset-0 bg-black z-50" onClick={handleTap}>
      {screen ? (
        <StreamVideo stream={screen} className="w-full h-full object-contain" />
      ) : (
        // Sem compartilhamento de tela: as câmeras dos amigos ocupam a tela toda
        <div className={`w-full h-full grid gap-1 ${friendsInRoom.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {friendsInRoom.length === 0 ? (
            <div className="flex items-center justify-center text-slate-300 text-sm font-semibold">
              Assim que alguém entrar na Sala, a câmera aparece aqui.
            </div>
          ) : (
            friendsInRoom.map((f) => (
              <div key={f} className="relative bg-black">
                <StreamVideo stream={remotes[f]?.cam || null} className="w-full h-full object-contain" />
                <span className="absolute bottom-3 left-3 px-2 py-0.5 rounded bg-black/60 text-white text-xs font-bold">{f}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Câmeras pequenas no canto (só sobre a tela compartilhada; podem ser escondidas) */}
      {screen && camsVisible && (
        <div className="absolute top-3 right-3 flex flex-col gap-2 w-[min(20vw,220px)] min-w-[120px]">
          {camTiles.map((tile) => (
            <div
              key={tile.key}
              className="relative aspect-video rounded-lg overflow-hidden bg-black border-2 shadow-xl"
              style={{ borderColor: tile.color }}
            >
              <StreamVideo
                stream={tile.stream}
                className={`w-full h-full ${tile.mine ? 'object-cover' : 'object-contain'}`}
                mirrored={tile.mine}
              />
              <span className="absolute bottom-1 left-1.5 px-1.5 rounded bg-black/60 text-white text-[10px] font-bold">
                {tile.label}
              </span>
              {tile.mine && !props.isCamEnabled && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white text-[10px] font-bold">
                  Câmera desligada
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(callHealth === 'degraded' || callHealth === 'recovering') && (
        <div className="absolute top-3 left-3 px-3 py-1.5 rounded-xl bg-amber-500/95 text-slate-950 text-xs font-bold shadow-xl">
          {callHealth === 'recovering' ? '⚠️ Reconectando...' : '⚠️ Conexão instável...'}
        </div>
      )}

      {/* Controles (somem sozinhos; um toque na tela traz de volta) */}
      {screen && (
        <div
          className={`absolute left-3 transition-opacity duration-300 ${fade} ${
            callHealth === 'degraded' || callHealth === 'recovering' ? 'top-14' : 'top-3'
          }`}
        >
          <span className="px-3 py-1.5 rounded-xl bg-black/60 text-white text-sm font-bold">
            🖥️ Tela de {remoteScreenSharer}
          </span>
        </div>
      )}
      <div
        className={`absolute bottom-0 inset-x-0 flex items-center justify-center gap-3 px-4 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-300 ${fade}`}
      >
        {screen && (
          <button
            type="button"
            onClick={action(() => setCamsVisible((v) => !v))}
            className="px-4 py-3 rounded-2xl border bg-slate-800/90 border-slate-600 text-white text-sm font-bold flex items-center gap-2"
          >
            {camsVisible ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            {camsVisible ? 'Esconder câmeras' : 'Mostrar câmeras'}
          </button>
        )}
        <button
          type="button"
          onClick={action(props.onToggleMic)}
          className={`p-3.5 rounded-2xl border text-white ${props.isMicMuted ? 'bg-red-600 border-red-400' : 'bg-slate-800/90 border-slate-600'}`}
          title="Mutar / desmutar microfone"
        >
          {props.isMicMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>
        <button
          type="button"
          onClick={action(props.onToggleFullscreen)}
          className="px-4 py-3 rounded-2xl border bg-slate-800/90 border-slate-600 text-white text-sm font-bold flex items-center gap-2"
        >
          <Minimize2 className="w-5 h-5" />
          Sair da tela cheia
        </button>
        <button
          type="button"
          onClick={action(props.onLeave)}
          className="p-3.5 rounded-2xl bg-red-600 border border-red-400 text-white"
          title="Sair da sala"
        >
          <PhoneOff className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
