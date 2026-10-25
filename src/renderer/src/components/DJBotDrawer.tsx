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
  const [liveDurationSec, setLiveDurationSec] = useState<number>(0)
  const [autoDucking, setAutoDucking] = useState<boolean>(() => {
    return localStorage.getItem('msn_dj_auto_ducking') === 'true'
  })

  const djStateRef = useRef<DjSyncState>(djState)
  djStateRef.current = djState
  const progressSecRef = useRef<number>(progressSec)
  progressSecRef.current = progressSec
  const endedLockRef = useRef<string | null>(null)

  const currentTrack: DjTrackItem | null =
    djState.playlist[djState.currentIndex] || null

  const handleToggleAutoDucking = (): void => {
    setAutoDucking((prev) => {
      const next = !prev
      localStorage.setItem('msn_dj_auto_ducking', String(next))
      return next
    })
  }

  // 1. Escuta o progresso de tempo real (00:01, 00:02...) vindo do motor nativo no processo Main
  useEffect(() => {
    const unsub = window.msnApi.onDjBotTimeUpdate((payload) => {
      const st = djStateRef.current
      const activeTrack = st.playlist[st.currentIndex]
      if (!activeTrack || activeTrack.videoId !== payload.videoId) return

      setProgressSec(payload.currentTime)
      if (payload.duration > 0) {
        setLiveDurationSec(payload.duration)
      }

      // Quando a faixa termina, avança automaticamente para a próxima
      if (payload.ended && endedLockRef.current !== payload.videoId) {
        endedLockRef.current = payload.videoId
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
      } else if (!payload.ended && payload.currentTime < 3) {
        endedLockRef.current = null
      }
    })
    return () => unsub()
  }, [currentUser, onUpdateDjState])

  // 2. Sincroniza a música atual, play/pause, seek e Auto-Ducking (-70%) opcional com o motor no Main
  useEffect(() => {
    const effectiveVolume =
      autoDucking && isAnyoneSpeaking ? Math.round(baseVolume * 0.3) : baseVolume

    window.msnApi.syncDjPlayer({
      videoId: currentTrack ? currentTrack.videoId : null,
      isPlaying: Boolean(currentTrack && djState.isPlaying),
      volume: effectiveVolume,
      seekSeconds: djState.currentTime || 0,
      seekTimestamp: djState.updatedAt
    })

    onCurrentTrackTitleChange(
      currentTrack && djState.isPlaying
        ? `${currentTrack.title} - ${currentTrack.author}`
        : null
    )
  }, [
    currentTrack?.videoId,
    djState.isPlaying,
    djState.currentIndex,
    djState.updatedAt,
    baseVolume,
    isAnyoneSpeaking,
    autoDucking
  ])

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

      // Lê o estado atual (não o da closure): a busca leva alguns segundos e o amigo pode ter
      // alterado a fila nesse meio tempo, e a música dele seria apagada.
      const latest = djStateRef.current
      const nextPlaylist = [...latest.playlist, newTrack]
      const shouldStartNow = latest.playlist.length === 0
      const nextState: DjSyncState = {
        playlist: nextPlaylist,
        currentIndex: shouldStartNow ? 0 : latest.currentIndex,
        isPlaying: shouldStartNow ? true : latest.isPlaying,
        currentTime: shouldStartNow ? 0 : progressSecRef.current,
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
    const nextState: DjSyncState = {
      ...djState,
      isPlaying: !djState.isPlaying,
      currentTime: progressSec,
      updatedBy: currentUser,
      updatedAt: Date.now()
    }
    onUpdateDjState(nextState, true)
  }

  const handleNext = (): void => {
    if (djState.playlist.length === 0) return
    const nextIndex = (djState.currentIndex + 1) % djState.playlist.length
    setProgressSec(0)
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
    setProgressSec(0)
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
    setProgressSec(0)
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

  const totalDuration = liveDurationSec || currentTrack?.durationSeconds || 0

  if (!isOpen) return null

  return (
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
              {formatTime(progressSec)} / {formatTime(totalDuration)}
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

            {autoDucking && isAnyoneSpeaking && (
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
            {autoDucking && isAnyoneSpeaking
              ? `${Math.round(baseVolume * 0.3)}%`
              : `${baseVolume}%`}
          </span>
        </div>

        {/* Opção de Ligar/Desligar Auto-Ducking */}
        <div className="flex items-center justify-between px-1 pt-1 border-t border-slate-700/50">
          <span className="text-[10px] text-slate-400">Abaixar som ao falar:</span>
          <button
            type="button"
            onClick={handleToggleAutoDucking}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              autoDucking
                ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-white'
            }`}
            title="Quando ligado, reduz a música em 70% automaticamente enquanto você ou seu amigo estiverem falando"
          >
            {autoDucking ? 'LIGADO (-70%)' : 'DESLIGADO'}
          </button>
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
  )
}
