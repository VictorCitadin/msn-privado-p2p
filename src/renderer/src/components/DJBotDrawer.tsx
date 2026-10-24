import React, { useEffect, useRef, useState } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Plus,
  Volume2,
  Trash2,
  Disc,
  Loader2,
  Radio,
  X
} from 'lucide-react'
import type { DjSyncState, DjTrackItem, MsnUser } from '../services/webrtc'

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        options: {
          height?: string | number
          width?: string | number
          videoId?: string
          playerVars?: Record<string, unknown>
          events?: {
            onReady?: (event: { target: YTPlayerInstance }) => void
            onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void
            onError?: (event: { data: number }) => void
          }
        }
      ) => YTPlayerInstance
      PlayerState?: {
        ENDED: number
        PLAYING: number
        PAUSED: number
      }
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

interface YTPlayerInstance {
  loadVideoById: (
    videoId: string | { videoId: string; startSeconds?: number; suggestedQuality?: string }
  ) => void
  playVideo: () => void
  pauseVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  setVolume: (volume: number) => void
  setPlaybackQuality: (suggestedQuality: string) => void
  getCurrentTime: () => number
  getDuration: () => number
  getPlayerState: () => number
  destroy: () => void
}

interface DJBotDrawerProps {
  isOpen: boolean
  onClose: () => void
  currentUser: MsnUser
  djState: DjSyncState
  isAnyoneSpeaking: boolean
  onUpdateDjState: (nextState: DjSyncState, broadcastP2P: boolean) => void
  onCurrentTrackTitleChange: (title: string | null) => void
}

export const DJBotDrawer: React.FC<DJBotDrawerProps> = ({
  isOpen,
  onClose,
  currentUser,
  djState,
  isAnyoneSpeaking,
  onUpdateDjState,
  onCurrentTrackTitleChange
}) => {
  const [inputQuery, setInputQuery] = useState('')
  const [isResolving, setIsResolving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [baseVolume, setBaseVolume] = useState<number>(75)
  const [progressSec, setProgressSec] = useState<number>(0)

  const playerRef = useRef<YTPlayerInstance | null>(null)
  const playerReadyRef = useRef<boolean>(false)
  const loadedVideoIdRef = useRef<string | null>(null)
  const djStateRef = useRef<DjSyncState>(djState)
  djStateRef.current = djState

  const currentTrack: DjTrackItem | null =
    djState.playlist[djState.currentIndex] || null

  // 1. Inicializa a API IFrame Oculta do YouTube (220x220 off-screen + qualidade 'small' para 0% de uso de GPU)
  useEffect(() => {
    const initPlayer = (): void => {
      if (playerRef.current || !window.YT || !window.YT.Player) return
      playerRef.current = new window.YT.Player('wmp-hidden-yt-player', {
        height: '220',
        width: '220',
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          rel: 0,
          playsinline: 1
        },
        events: {
          onReady: (ev) => {
            playerReadyRef.current = true
            ev.target.setPlaybackQuality('small')
            ev.target.setVolume(baseVolume)

            const st = djStateRef.current
            const track = st.playlist[st.currentIndex]
            if (track) {
              loadedVideoIdRef.current = track.videoId
              ev.target.loadVideoById({
                videoId: track.videoId,
                startSeconds: st.currentTime || 0,
                suggestedQuality: 'small'
              })
              if (st.isPlaying) {
                ev.target.playVideo()
              } else {
                ev.target.pauseVideo()
              }
            }
          },
          onStateChange: (ev) => {
            ev.target.setPlaybackQuality('small')
            // Se o vídeo foi carregado (CUED = 5) e o estado global é isPlaying, dispara playVideo()
            if (ev.data === 5 && djStateRef.current.isPlaying) {
              ev.target.playVideo()
            }
            // Quando a faixa termina (ENDED = 0), avança automaticamente para a próxima
            if (ev.data === 0) {
              const st = djStateRef.current
              if (st.playlist.length > 0) {
                const nextIndex = (st.currentIndex + 1) % st.playlist.length
                const nextState: DjSyncState = {
                  ...st,
                  currentIndex: nextIndex,
                  isPlaying: true,
                  currentTime: 0,
                  updatedBy: currentUser,
                  updatedAt: Date.now()
                }
                onUpdateDjState(nextState, true)
              }
            }
          },
          onError: async (ev) => {
            // Se um videoclipe VEVO bloquear embed (erro 101 ou 150), busca versão Lyrics/Topic automaticamente
            const st = djStateRef.current
            const failedTrack = st.playlist[st.currentIndex]
            if (failedTrack && (ev.data === 101 || ev.data === 150)) {
              try {
                const alt = await window.msnApi.resolveDjTrack(
                  `${failedTrack.title} ${failedTrack.author} lyrics`
                )
                if (alt.videoId && alt.videoId !== failedTrack.videoId) {
                  loadedVideoIdRef.current = alt.videoId
                  playerRef.current?.loadVideoById({
                    videoId: alt.videoId,
                    startSeconds: 0,
                    suggestedQuality: 'small'
                  })
                  playerRef.current?.playVideo()
                  return
                }
              } catch {
                // ignora e avisa abaixo
              }
            }
            setErrorMsg('Faixa com bloqueio de embed; tentando próxima da fila...')
          }
        }
      })
    }

    if (window.YT && window.YT.Player) {
      initPlayer()
    } else {
      const existingScript = document.getElementById('yt-iframe-api-script')
      if (!existingScript) {
        const tag = document.createElement('script')
        tag.id = 'yt-iframe-api-script'
        tag.src = 'https://www.youtube.com/iframe_api'
        document.body.appendChild(tag)
      }
      window.onYouTubeIframeAPIReady = () => {
        initPlayer()
      }
    }
  }, [])

  // 2. Sincroniza estado do DJ Bot (música atual, play/pause e seek) com o Player IFrame
  useEffect(() => {
    const player = playerRef.current
    if (!player || !playerReadyRef.current) return

    if (!currentTrack) {
      player.pauseVideo()
      loadedVideoIdRef.current = null
      onCurrentTrackTitleChange(null)
      return
    }

    if (loadedVideoIdRef.current !== currentTrack.videoId) {
      loadedVideoIdRef.current = currentTrack.videoId
      player.loadVideoById({
        videoId: currentTrack.videoId,
        startSeconds: djState.currentTime || 0,
        suggestedQuality: 'small'
      })
      if (djState.isPlaying) {
        player.playVideo()
      } else {
        player.pauseVideo()
      }
    } else {
      const currentPos = player.getCurrentTime ? player.getCurrentTime() : 0
      if (Math.abs(currentPos - (djState.currentTime || 0)) > 4) {
        player.seekTo(djState.currentTime || 0, true)
      }
      if (djState.isPlaying) {
        player.playVideo()
      } else {
        player.pauseVideo()
      }
    }

    onCurrentTrackTitleChange(
      djState.isPlaying ? `${currentTrack.title} - ${currentTrack.author}` : null
    )
  }, [
    currentTrack?.videoId,
    djState.isPlaying,
    djState.currentIndex,
    djState.updatedAt
  ])

  // 3. Auto-Ducking: reduz suavemente o volume em 70% quando alguém fala no microfone
  useEffect(() => {
    const player = playerRef.current
    if (!player || !playerReadyRef.current) return
    const targetVolume = isAnyoneSpeaking ? Math.round(baseVolume * 0.3) : baseVolume
    player.setVolume(targetVolume)
  }, [baseVolume, isAnyoneSpeaking])

  // 4. Relógio de progresso do visor WMP
  useEffect(() => {
    const timer = setInterval(() => {
      if (playerRef.current && playerReadyRef.current && djStateRef.current.isPlaying) {
        const sec = Math.floor(playerRef.current.getCurrentTime() || 0)
        setProgressSec(sec)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Adicionar música por nome, link do YouTube ou link do Spotify
  const handleAddTrack = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!inputQuery.trim() || isResolving) return

    setIsResolving(true)
    setErrorMsg(null)
    try {
      const resolved = await window.msnApi.resolveDjTrack(inputQuery.trim())
      const newTrack: DjTrackItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        videoId: resolved.videoId,
        title: resolved.title,
        author: resolved.author,
        durationSeconds: resolved.durationSeconds,
        thumbnail: resolved.thumbnail,
        addedBy: currentUser
      }

      const nextPlaylist = [...djState.playlist, newTrack]
      const shouldStartNow = djState.playlist.length === 0
      const nextState: DjSyncState = {
        playlist: nextPlaylist,
        currentIndex: shouldStartNow ? 0 : djState.currentIndex,
        isPlaying: shouldStartNow ? true : djState.isPlaying,
        currentTime: shouldStartNow ? 0 : progressSec,
        updatedBy: currentUser,
        updatedAt: Date.now()
      }

      setInputQuery('')
      onUpdateDjState(nextState, true)
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao buscar música.')
    } finally {
      setIsResolving(false)
    }
  }

  const handleTogglePlay = (): void => {
    if (djState.playlist.length === 0) return
    const currentSec =
      playerRef.current && playerReadyRef.current
        ? Math.floor(playerRef.current.getCurrentTime() || 0)
        : progressSec

    const nextState: DjSyncState = {
      ...djState,
      isPlaying: !djState.isPlaying,
      currentTime: currentSec,
      updatedBy: currentUser,
      updatedAt: Date.now()
    }
    onUpdateDjState(nextState, true)
  }

  const handleNext = (): void => {
    if (djState.playlist.length === 0) return
    const nextIndex = (djState.currentIndex + 1) % djState.playlist.length
    onUpdateDjState(
      {
        ...djState,
        currentIndex: nextIndex,
        isPlaying: true,
        currentTime: 0,
        updatedBy: currentUser,
        updatedAt: Date.now()
      },
      true
    )
  }

  const handlePrev = (): void => {
    if (djState.playlist.length === 0) return
    const prevIndex =
      (djState.currentIndex - 1 + djState.playlist.length) % djState.playlist.length
    onUpdateDjState(
      {
        ...djState,
        currentIndex: prevIndex,
        isPlaying: true,
        currentTime: 0,
        updatedBy: currentUser,
        updatedAt: Date.now()
      },
      true
    )
  }

  const handleSelectTrack = (index: number): void => {
    onUpdateDjState(
      {
        ...djState,
        currentIndex: index,
        isPlaying: true,
        currentTime: 0,
        updatedBy: currentUser,
        updatedAt: Date.now()
      },
      true
    )
  }

  const handleRemoveTrack = (index: number): void => {
    const nextPlaylist = djState.playlist.filter((_, i) => i !== index)
    let nextIdx = djState.currentIndex
    if (index < nextIdx) nextIdx = Math.max(0, nextIdx - 1)
    if (nextIdx >= nextPlaylist.length) nextIdx = Math.max(0, nextPlaylist.length - 1)

    onUpdateDjState(
      {
        playlist: nextPlaylist,
        currentIndex: nextIdx,
        isPlaying: nextPlaylist.length > 0 ? djState.isPlaying : false,
        currentTime: 0,
        updatedBy: currentUser,
        updatedAt: Date.now()
      },
      true
    )
  }

  const formatTime = (sec: number): string => {
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  return (
    <>
      {/* Player IFrame 220x220 Off-Screen (Atende ao requisito mínimo de 200x200px da API do YouTube com 0% de GPU) */}
      <div
        style={{
          position: 'fixed',
          width: '220px',
          height: '220px',
          left: '-9999px',
          top: '-9999px',
          pointerEvents: 'none',
          zIndex: -1
        }}
      >
        <div id="wmp-hidden-yt-player" />
      </div>

      {isOpen && (
        <aside className="w-80 shrink-0 wmp-shell text-slate-100 flex flex-col h-full select-none shadow-2xl z-30">
          {/* Cabeçalho Estilo Windows Media Player 9/10 */}
          <div className="px-3 py-2 bg-gradient-to-r from-[#1f293d] via-[#34496e] to-[#1f293d] border-b border-[#587099] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Disc className="w-4 h-4 text-[#76ff03] animate-spin" style={{ animationDuration: '6s' }} />
              <span className="text-xs font-bold tracking-wider text-white uppercase">
                Windows Media Player DJ Bot
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/15 text-slate-300 hover:text-white"
              title="Recolher Gaveta DJ Bot"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Visor Preto com Letras Verde-Limão + Espectro de Barras CSS */}
          <div className="p-3">
            <div className="wmp-visor rounded-lg p-3 font-wmp text-[#76ff03] relative overflow-hidden">
              <div className="flex items-center justify-between text-[10px] text-[#76ff03]/80 mb-1">
                <span className="flex items-center gap-1">
                  <Radio className="w-3 h-3" />
                  SYNC P2P: {djState.updatedBy.toUpperCase()}
                </span>
                <span>
                  {formatTime(progressSec)} /{' '}
                  {formatTime(currentTrack?.durationSeconds || 0)}
                </span>
              </div>

              <div className="text-xs font-bold truncate leading-tight mb-0.5">
                {currentTrack ? currentTrack.title : 'NENHUMA FAIXA NA FILA'}
              </div>
              <div className="text-[11px] text-[#a2ff54]/80 truncate mb-2.5">
                {currentTrack
                  ? `${currentTrack.author} (Adicionado por ${currentTrack.addedBy})`
                  : 'Cole link Spotify, YouTube ou nome da música'}
              </div>

              {/* Espectro de Barras em CSS + Status de Auto-Ducking */}
              <div className="flex items-end justify-between h-8 gap-1 pt-1 border-t border-[#1c361c]">
                <div className="flex items-end gap-0.5 h-full flex-1">
                  {Array.from({ length: 20 }).map((_, idx) => (
                    <div
                      key={idx}
                      className={`flex-1 bg-gradient-to-t from-[#32cb00] via-[#76ff03] to-[#ccff90] rounded-t-xs ${
                        djState.isPlaying ? 'wmp-eq-bar' : 'h-1'
                      }`}
                      style={{
                        height: djState.isPlaying ? `${30 + ((idx * 19) % 70)}%` : '15%',
                        animationDelay: `${(idx % 7) * 0.09}s`
                      }}
                    />
                  ))}
                </div>

                {isAnyoneSpeaking && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-400 text-amber-300 text-[9px] font-bold whitespace-nowrap">
                    🔉 AUTO-DUCK -70%
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Controles Clássicos WMP: Anterior [|<], Play/Pause, Próxima [>|] e Volume */}
          <div className="px-3 pb-3 flex flex-col gap-2.5 border-b border-slate-700/80">
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={handlePrev}
                disabled={djState.playlist.length === 0}
                className="px-2.5 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-500 text-xs font-bold flex items-center gap-1 disabled:opacity-40"
                title="Anterior [|<]"
              >
                <SkipBack className="w-3.5 h-3.5" />
                <span>|&lt;</span>
              </button>

              <button
                type="button"
                onClick={handleTogglePlay}
                disabled={djState.playlist.length === 0}
                className="w-11 h-11 rounded-full bg-gradient-to-b from-[#4facfe] to-[#1a5fb4] hover:brightness-110 border-2 border-[#a1cfff] shadow-lg flex items-center justify-center text-white disabled:opacity-40"
                title="Play / Pause Sincronizado"
              >
                {djState.isPlaying ? (
                  <Pause className="w-5 h-5" />
                ) : (
                  <Play className="w-5 h-5 ml-0.5" />
                )}
              </button>

              <button
                type="button"
                onClick={handleNext}
                disabled={djState.playlist.length === 0}
                className="px-2.5 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-500 text-xs font-bold flex items-center gap-1 disabled:opacity-40"
                title="Próxima [>|]"
              >
                <span>&gt;|</span>
                <SkipForward className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Controle de Volume */}
            <div className="flex items-center gap-2 px-1">
              <Volume2 className="w-4 h-4 text-[#76ff03] shrink-0" />
              <input
                type="range"
                min={0}
                max={100}
                value={baseVolume}
                onChange={(e) => setBaseVolume(Number(e.target.value))}
                className="w-full accent-[#76ff03] h-1.5 bg-slate-700 rounded cursor-pointer"
              />
              <span className="text-[11px] font-wmp text-[#76ff03] w-9 text-right">
                {isAnyoneSpeaking ? `${Math.round(baseVolume * 0.3)}%` : `${baseVolume}%`}
              </span>
            </div>
          </div>

          {/* Input Sem Comandos: Nome da Música, Link do YouTube ou Link do Spotify */}
          <form onSubmit={handleAddTrack} className="p-3 border-b border-slate-700/80 space-y-1.5">
            <label className="block text-[11px] text-slate-300 font-semibold">
              Adicionar Música (Nome, YouTube ou Spotify):
            </label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={inputQuery}
                onChange={(e) => setInputQuery(e.target.value)}
                placeholder="Ex: Linkin Park Numb ou link Spotify..."
                className="flex-1 px-2.5 py-1.5 rounded bg-[#0c121c] border border-slate-600 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#76ff03]"
              />
              <button
                type="submit"
                disabled={isResolving || !inputQuery.trim()}
                className="px-2.5 py-1.5 rounded bg-gradient-to-b from-[#52b700] to-[#347800] border border-[#76ff03]/60 text-white text-xs font-bold flex items-center gap-1 hover:brightness-110 disabled:opacity-50 shrink-0"
              >
                {isResolving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                <span>Adicionar</span>
              </button>
            </div>
            {errorMsg && <p className="text-[11px] text-red-400 font-medium">{errorMsg}</p>}
          </form>

          {/* Playlist Sincronizada P2P */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <div className="px-1 py-0.5 flex items-center justify-between text-[11px] text-slate-400 font-semibold">
              <span>FILA DE REPRODUÇÃO ({djState.playlist.length})</span>
              <span>SINCRONIZADO P2P</span>
            </div>

            {djState.playlist.length === 0 ? (
              <div className="text-center py-8 px-3 text-xs text-slate-400">
                Fila vazia. Adicione uma música acima ou clique em{' '}
                <strong className="text-[#76ff03]">🎧 Ouvir Álbum Juntos</strong> no Rankeador de
                Álbuns!
              </div>
            ) : (
              djState.playlist.map((item, idx) => {
                const isCurrent = idx === djState.currentIndex
                return (
                  <div
                    key={item.id}
                    onClick={() => handleSelectTrack(idx)}
                    className={`group flex items-center justify-between gap-2 p-2 rounded cursor-pointer border transition-colors ${
                      isCurrent
                        ? 'bg-[#132a13] border-[#76ff03]/60 text-[#76ff03]'
                        : 'bg-slate-800/60 border-slate-700/60 text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold truncate">
                        {idx + 1}. {item.title}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {item.author} • por {item.addedBy} • {formatTime(item.durationSeconds)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveTrack(idx)
                      }}
                      className="opacity-60 group-hover:opacity-100 p-1 rounded hover:bg-red-500/20 hover:text-red-300"
                      title="Remover da fila"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </aside>
      )}
    </>
  )
}
