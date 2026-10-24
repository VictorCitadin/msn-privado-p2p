import React, { useEffect, useRef, useState } from 'react'
import {
  Search,
  Star,
  Trophy,
  Headphones,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Play,
  Pause,
  CheckCircle2,
  Clock,
  Sparkles,
  Disc,
  Save,
  Edit3,
  Loader2
} from 'lucide-react'
import type {
  AlbumRankingRecord,
  AlbumSearchResult,
  AlbumTrackItem
} from '../../../preload/index'
import type { MsnUser } from '../services/webrtc'

type RankerSubView = 'list' | 'create-edit' | 'compare'

/**
 * Componente Interativo de 5 Estrelas com suporte a Meias-Estrelas (0.5 a 5.0)
 */
const HalfStarRating: React.FC<{
  value: number
  onChange?: (val: number) => void
  readOnly?: boolean
  size?: 'sm' | 'md' | 'lg'
}> = ({ value, onChange, readOnly = false, size = 'md' }) => {
  const starSize = size === 'lg' ? 'w-7 h-7' : size === 'md' ? 'w-5 h-5' : 'w-4 h-4'

  const handleClick = (starIdx: number, e: React.MouseEvent<HTMLButtonElement>): void => {
    if (readOnly || !onChange) return
    const rect = e.currentTarget.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const isLeftHalf = clickX < rect.width / 2
    const nextValue = isLeftHalf ? starIdx - 0.5 : starIdx
    onChange(Math.max(0.5, Math.min(5.0, nextValue)))
  }

  return (
    <div className="inline-flex items-center gap-1 select-none">
      {[1, 2, 3, 4, 5].map((starIdx) => {
        const full = value >= starIdx
        const half = !full && value >= starIdx - 0.5

        return (
          <button
            key={starIdx}
            type="button"
            disabled={readOnly}
            onClick={(e) => handleClick(starIdx, e)}
            className={`relative ${starSize} ${
              readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-110 transition-transform'
            }`}
            title={readOnly ? `${value.toFixed(1)} / 5.0` : 'Clique na metade esquerda (.5) ou direita (.0)'}
          >
            {/* Estrela Base Vazia */}
            <Star className={`${starSize} text-slate-600 fill-slate-800`} />

            {/* Preenchimento Inteiro ou Meio */}
            {(full || half) && (
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ width: half ? '50%' : '100%' }}
              >
                <Star className={`${starSize} text-amber-400 fill-amber-400`} />
              </div>
            )}
          </button>
        )
      })}
      <span
        className={`ml-1.5 font-bold ${
          size === 'lg' ? 'text-base' : 'text-xs'
        } text-amber-300`}
      >
        {value ? `${Number(value).toFixed(1)} / 5.0` : 'Sem nota'}
      </span>
    </div>
  )
}

/**
 * Formata data ISO para dd/MM/yyyy
 */
function formatDateBr(iso?: string | null): string {
  if (!iso) return '--/--/----'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--/--/----'
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
}

/**
 * Calcula a Porcentagem de Compatibilidade (%) entre o ranking do Vitinho e do Will
 * usando a Distância de Posições / Correlação de Spearman normalizada (0% a 100%).
 */
function calculateCompatibilityPercentage(
  vitinhoOrder?: string[] | null,
  willOrder?: string[] | null
): number | null {
  if (
    !vitinhoOrder ||
    !willOrder ||
    vitinhoOrder.length === 0 ||
    willOrder.length === 0
  ) {
    return null
  }

  const n = Math.min(vitinhoOrder.length, willOrder.length)
  if (n <= 1) return 100

  let sumAbsDiff = 0
  for (let i = 0; i < vitinhoOrder.length; i++) {
    const trackId = vitinhoOrder[i]
    const willIdx = willOrder.indexOf(trackId)
    if (willIdx !== -1) {
      sumAbsDiff += Math.abs(i - willIdx)
    }
  }

  // Distância máxima possível quando uma lista é o inverso exato da outra: floor(n^2 / 2)
  const maxPossibleDiff = Math.floor((n * n) / 2)
  if (maxPossibleDiff === 0) return 100

  const ratio = 1 - sumAbsDiff / maxPossibleDiff
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

export const AlbumRankerWindow: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<MsnUser>('Vitinho')
  const [subView, setSubView] = useState<RankerSubView>('list')
  const [rankings, setRankings] = useState<AlbumRankingRecord[]>([])
  const [loadingRankings, setLoadingRankings] = useState<boolean>(true)

  // Busca de novo álbum (iTunes Search API / Deezer API)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [searchResults, setSearchResults] = useState<AlbumSearchResult[]>([])
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [isLoadingAlbumTracks, setIsLoadingAlbumTracks] = useState<boolean>(false)

  // Álbum selecionado para Criar/Editar Meu Ranking
  const [editingAlbum, setEditingAlbum] = useState<{
    albumId: string
    albumName: string
    artistName: string
    artworkUrl: string
    releaseYear: string
    tracks: AlbumTrackItem[]
  } | null>(null)
  const [orderedTracks, setOrderedTracks] = useState<AlbumTrackItem[]>([])
  const [myRating, setMyRating] = useState<number>(4.5)
  const [myComment, setMyComment] = useState<string>('')
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  // Álbum selecionado para Comparação Lado a Lado
  const [selectedComparison, setSelectedComparison] = useState<AlbumRankingRecord | null>(
    null
  )

  // Preview de 30s (iTunes/Deezer previewUrl)
  const [playingPreviewTrackId, setPlayingPreviewTrackId] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const [toastBanner, setToastBanner] = useState<string | null>(null)

  const showToast = (msg: string): void => {
    setToastBanner(msg)
    setTimeout(() => setToastBanner(null), 4000)
  }

  const loadInitialData = async (): Promise<void> => {
    setLoadingRankings(true)
    try {
      const session = await window.msnApi.getSession()
      if (session.sessionUser) {
        setCurrentUser(session.sessionUser)
      }
      const list = await window.msnApi.listAlbumRankings()
      setRankings(list)
    } catch (err) {
      console.error('[AlbumRanker] Erro ao carregar rankings:', err)
    } finally {
      setLoadingRankings(false)
    }
  }

  useEffect(() => {
    loadInitialData()
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause()
        previewAudioRef.current = null
      }
    }
  }, [])

  // Play / Pause do Preview de 30 segundos da faixa
  const toggleTrackPreview = (track: AlbumTrackItem): void => {
    if (!track.previewUrl) return

    if (playingPreviewTrackId === track.trackId && previewAudioRef.current) {
      previewAudioRef.current.pause()
      setPlayingPreviewTrackId(null)
      return
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
    }

    const audio = new Audio(track.previewUrl)
    audio.volume = 0.7
    audio.onended = () => setPlayingPreviewTrackId(null)
    audio.play().catch(() => {})
    previewAudioRef.current = audio
    setPlayingPreviewTrackId(track.trackId)
  }

  // Buscar Álbuns na API iTunes / Deezer
  const handleSearchAlbums = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!searchQuery.trim()) return
    setIsSearching(true)
    try {
      const results = await window.msnApi.searchAlbums(searchQuery.trim())
      setSearchResults(results)
    } catch (err) {
      console.error('[AlbumRanker] Erro na busca:', err)
    } finally {
      setIsSearching(false)
    }
  }

  // Selecionar um álbum da busca (ou um já existente para editar meu voto)
  const handleSelectAlbumToRank = async (
    albumId: string,
    existingRecord?: AlbumRankingRecord
  ): Promise<void> => {
    setIsLoadingAlbumTracks(true)
    try {
      let albumDetails: {
        albumId: string
        albumName: string
        artistName: string
        artworkUrl: string
        releaseYear: string
        tracks: AlbumTrackItem[]
      }

      if (existingRecord && existingRecord.tracks_metadata?.length > 0) {
        albumDetails = {
          albumId: existingRecord.album_id,
          albumName: existingRecord.album_name,
          artistName: existingRecord.artist_name,
          artworkUrl: existingRecord.artwork_url,
          releaseYear: existingRecord.release_year || '',
          tracks: existingRecord.tracks_metadata
        }
      } else {
        albumDetails = await window.msnApi.getAlbumTracks(albumId)
      }

      const existing =
        existingRecord || rankings.find((r) => r.album_id === albumDetails.albumId)

      const savedOrder =
        currentUser === 'Vitinho'
          ? existing?.vitinho_track_order
          : existing?.will_track_order
      const savedRating =
        currentUser === 'Vitinho' ? existing?.vitinho_rating : existing?.will_rating
      const savedComment =
        currentUser === 'Vitinho' ? existing?.vitinho_comment : existing?.will_comment

      let initialTracks = [...albumDetails.tracks]
      if (savedOrder && savedOrder.length > 0) {
        const trackMap = new Map(initialTracks.map((t) => [t.trackId, t]))
        const ordered: AlbumTrackItem[] = []
        for (const id of savedOrder) {
          const found = trackMap.get(id)
          if (found) {
            ordered.push(found)
            trackMap.delete(id)
          }
        }
        for (const remaining of trackMap.values()) {
          ordered.push(remaining)
        }
        initialTracks = ordered
      }

      setEditingAlbum(albumDetails)
      setOrderedTracks(initialTracks)
      setMyRating(savedRating ? Number(savedRating) : 4.5)
      setMyComment(savedComment || '')
      setSubView('create-edit')
    } catch (err) {
      console.error('[AlbumRanker] Erro ao carregar faixas do álbum:', err)
    } finally {
      setIsLoadingAlbumTracks(false)
    }
  }

  // Reordenação de músicas (Drag-and-Drop + Botões Subir/Descer)
  const moveTrack = (fromIdx: number, toIdx: number): void => {
    if (toIdx < 0 || toIdx >= orderedTracks.length) return
    const copy = [...orderedTracks]
    const [moved] = copy.splice(fromIdx, 1)
    copy.splice(toIdx, 0, moved)
    setOrderedTracks(copy)
  }

  const handleSaveRanking = async (): Promise<void> => {
    if (!editingAlbum || isSaving) return
    setIsSaving(true)
    try {
      const savedRecord = await window.msnApi.saveAlbumRanking({
        albumId: editingAlbum.albumId,
        albumName: editingAlbum.albumName,
        artistName: editingAlbum.artistName,
        artworkUrl: editingAlbum.artworkUrl,
        releaseYear: editingAlbum.releaseYear,
        tracksMetadata: editingAlbum.tracks,
        user: currentUser,
        rating: myRating,
        comment: myComment.trim(),
        trackOrder: orderedTracks.map((t) => t.trackId)
      })

      const updatedList = await window.msnApi.listAlbumRankings()
      setRankings(updatedList)
      setSelectedComparison(savedRecord)
      setSubView('compare')
      showToast(`🏆 Ranking de "${editingAlbum.albumName}" salvo e sincronizado com sucesso!`)
    } catch (err) {
      console.error('[AlbumRanker] Erro ao salvar ranking:', err)
    } finally {
      setIsSaving(false)
    }
  }

  // Botão "🎧 Ouvir Álbum Juntos no DJ Bot"
  const handleQueueAlbumInDjBot = async (
    albumName: string,
    artistName: string,
    tracks: AlbumTrackItem[]
  ): Promise<void> => {
    await window.msnApi.queueAlbumInDjBot({
      albumName,
      artistName,
      tracks: tracks.map((t) => ({ trackName: t.trackName }))
    })
    showToast(`🎧 As ${tracks.length} faixas de "${albumName}" foram enviadas para o DJ Bot!`)
  }

  return (
    <div className="h-screen w-screen bg-gradient-to-b from-[#0d1526] via-[#111c33] to-[#0a101d] text-slate-100 flex flex-col overflow-hidden select-none">
      {/* Cabeçalho Clássico MSN Music / WMP Library */}
      <header className="px-6 py-3.5 bg-gradient-to-r from-[#1b3a6b] via-[#26569c] to-[#17325c] border-b-2 border-[#4f8ad8] shadow-lg flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center shadow-md border border-amber-200">
            <Trophy className="w-5 h-5 text-slate-950" />
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-wide text-white flex items-center gap-2">
              MSN MUSIC — RANKEADOR DE ÁLBUNS
              <span className="px-2 py-0.5 text-[10px] rounded-full bg-[#76ff03]/20 border border-[#76ff03] text-[#76ff03] font-bold">
                VITINHO &amp; WILL CLOUD SYNC
              </span>
            </h1>
            <p className="text-xs text-sky-200">
              Avalie discos faixa a faixa, compare o Top 3 e veja a % de compatibilidade musical
            </p>
          </div>
        </div>

        {/* Seletor rápido de conta ativa + Botões de Navegação */}
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-900/80 p-1 rounded-lg border border-slate-600 text-xs">
            <span className="px-2 text-slate-400">Avaliando como:</span>
            {(['Vitinho', 'Will'] as MsnUser[]).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setCurrentUser(u)}
                className={`px-3 py-1 rounded-md font-bold transition-colors ${
                  currentUser === u
                    ? 'bg-[#357cc2] text-white shadow'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {u}
              </button>
            ))}
          </div>

          {subView !== 'list' && (
            <button
              type="button"
              onClick={() => {
                setEditingAlbum(null)
                setSubView('list')
              }}
              className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-500 text-xs font-bold flex items-center gap-1.5"
            >
              <ArrowLeft className="w-4 h-4" />
              Voltar à Biblioteca
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setEditingAlbum(null)
              setSubView('create-edit')
            }}
            className="px-4 py-2 rounded-lg bg-gradient-to-b from-[#52b700] to-[#367c00] hover:brightness-110 border border-[#8cff32] text-white text-xs font-extrabold shadow-md flex items-center gap-1.5"
          >
            <Search className="w-4 h-4" />
            <span>🔍 Buscar e Rankear Novo Álbum</span>
          </button>
        </div>
      </header>

      {/* Banner de Notificação */}
      {toastBanner && (
        <div className="bg-emerald-600/95 text-white px-6 py-2 text-xs font-bold text-center shadow-md">
          {toastBanner}
        </div>
      )}

      {/* ==================================================================== */}
      {/* SUB-VISÃO 1: TELA INICIAL (LISTA DE RANKINGS JÁ FEITOS)               */}
      {/* ==================================================================== */}
      {subView === 'list' && (
        <main className="flex-1 overflow-y-auto p-6">
          {loadingRankings ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-sky-400" />
              <span className="text-sm">Sincronizando biblioteca de álbuns com o Supabase...</span>
            </div>
          ) : rankings.length === 0 ? (
            <div className="max-w-xl mx-auto mt-14 p-8 rounded-2xl bg-slate-900/90 border border-slate-700 text-center space-y-4">
              <Disc className="w-14 h-14 text-sky-400 mx-auto" />
              <h2 className="text-lg font-bold text-white">
                Nenhum álbum foi rankeado ainda!
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                Clique no botão abaixo para buscar qualquer álbum na API oficial do iTunes / Deezer,
                ouvir juntos no DJ Bot e descobrir a compatibilidade do ranking entre Vitinho e Will.
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditingAlbum(null)
                  setSubView('create-edit')
                }}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-b from-[#4facfe] to-[#1d63b8] text-white text-xs font-bold shadow-lg"
              >
                🔍 Buscar e Rankear Primeiro Álbum
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {rankings.map((item) => {
                const vitinhoVoted =
                  typeof item.vitinho_rating === 'number' &&
                  Array.isArray(item.vitinho_track_order) &&
                  item.vitinho_track_order.length > 0
                const willVoted =
                  typeof item.will_rating === 'number' &&
                  Array.isArray(item.will_track_order) &&
                  item.will_track_order.length > 0
                const bothVoted = vitinhoVoted && willVoted
                const compatibility = calculateCompatibilityPercentage(
                  item.vitinho_track_order,
                  item.will_track_order
                )
                const rankedDate = formatDateBr(
                  item.updated_at || item.vitinho_ranked_at || item.will_ranked_at
                )

                return (
                  <div
                    key={item.album_id}
                    className="rounded-2xl bg-gradient-to-b from-[#17233b] to-[#101829] border border-[#304a78] hover:border-[#5b93e8] shadow-xl overflow-hidden flex flex-col justify-between transition-all"
                  >
                    <div className="p-4 flex gap-4">
                      {/* Capa do Álbum em Alta Resolução */}
                      <div
                        onClick={() => {
                          setSelectedComparison(item)
                          setSubView('compare')
                        }}
                        className="w-32 h-32 rounded-xl overflow-hidden shrink-0 border-2 border-slate-600 shadow-lg cursor-pointer group relative"
                      >
                        <img
                          src={item.artwork_url}
                          alt={item.album_name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                        {compatibility !== null && (
                          <span className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-full bg-black/85 border border-amber-400 text-amber-300 text-[10px] font-extrabold">
                            {compatibility}% Match
                          </span>
                        )}
                      </div>

                      {/* Informações do Álbum e Status dos Votos */}
                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <h3
                              onClick={() => {
                                setSelectedComparison(item)
                                setSubView('compare')
                              }}
                              className="text-base font-extrabold text-white truncate cursor-pointer hover:text-sky-300"
                            >
                              {item.album_name}
                            </h3>
                            <span className="text-[11px] text-slate-400 shrink-0">
                              📅 {rankedDate}
                            </span>
                          </div>
                          <p className="text-xs text-sky-300 font-semibold truncate mb-2">
                            {item.artist_name}{' '}
                            {item.release_year ? `(${item.release_year})` : ''}
                          </p>

                          {/* Badge indicando se ambos já votaram ou se falta um votar */}
                          {bothVoted ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400 text-emerald-300 text-[11px] font-bold">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Ambos já votaram! ({compatibility}% Compatibilidade)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-400 text-amber-300 text-[11px] font-bold">
                              <Clock className="w-3.5 h-3.5" />
                              {vitinhoVoted
                                ? 'Falta Will votar neste álbum'
                                : 'Falta Vitinho votar neste álbum'}
                            </span>
                          )}
                        </div>

                        {/* Notas em Estrelas e Comentários de Vitinho e Will */}
                        <div className="mt-3 grid grid-cols-2 gap-2.5 pt-2.5 border-t border-slate-700/80">
                          <div className="p-2 rounded-lg bg-slate-900/75 border border-slate-700/80">
                            <div className="text-[11px] font-bold text-sky-300 mb-0.5">
                              Vitinho:
                            </div>
                            {vitinhoVoted ? (
                              <>
                                <HalfStarRating
                                  value={Number(item.vitinho_rating)}
                                  readOnly
                                  size="sm"
                                />
                                <p className="text-[11px] text-slate-300 italic line-clamp-2 mt-1">
                                  &ldquo;{item.vitinho_comment || 'Sem comentário'}&rdquo;
                                </p>
                              </>
                            ) : (
                              <span className="text-[11px] text-slate-500">
                                Ainda não avaliou
                              </span>
                            )}
                          </div>

                          <div className="p-2 rounded-lg bg-slate-900/75 border border-slate-700/80">
                            <div className="text-[11px] font-bold text-emerald-300 mb-0.5">
                              Will:
                            </div>
                            {willVoted ? (
                              <>
                                <HalfStarRating
                                  value={Number(item.will_rating)}
                                  readOnly
                                  size="sm"
                                />
                                <p className="text-[11px] text-slate-300 italic line-clamp-2 mt-1">
                                  &ldquo;{item.will_comment || 'Sem comentário'}&rdquo;
                                </p>
                              </>
                            ) : (
                              <span className="text-[11px] text-slate-500">
                                Ainda não avaliou
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Barra Inferior de Ações do Card */}
                    <div className="px-4 py-2.5 bg-slate-950/70 border-t border-slate-800 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          handleQueueAlbumInDjBot(
                            item.album_name,
                            item.artist_name,
                            item.tracks_metadata || []
                          )
                        }
                        className="px-3 py-1.5 rounded-lg bg-[#193319] hover:bg-[#224722] border border-[#76ff03]/60 text-[#76ff03] text-xs font-bold flex items-center gap-1.5"
                      >
                        <Headphones className="w-3.5 h-3.5" />
                        <span>🎧 Ouvir Álbum Juntos no DJ Bot</span>
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSelectAlbumToRank(item.album_id, item)}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-slate-200 flex items-center gap-1"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Meu Ranking ({currentUser})</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedComparison(item)
                            setSubView('compare')
                          }}
                          className="px-3.5 py-1.5 rounded-lg bg-gradient-to-b from-[#4facfe] to-[#1f62b5] text-white text-xs font-bold shadow"
                        >
                          Ver Comparação Lado a Lado
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </main>
      )}

      {/* ==================================================================== */}
      {/* SUB-VISÃO 2: TELA DE CRIAÇÃO / EDIÇÃO DO MEU RANKING                  */}
      {/* ==================================================================== */}
      {subView === 'create-edit' && (
        <main className="flex-1 overflow-y-auto p-6">
          {!editingAlbum ? (
            /* Passo 1: Buscar Álbum na API Oficial (iTunes Search + Deezer Fallback) */
            <div className="max-w-4xl mx-auto space-y-5">
              <form
                onSubmit={handleSearchAlbums}
                className="p-4 rounded-2xl bg-slate-900/90 border border-slate-700 flex gap-3 shadow-lg"
              >
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Digite o nome do Álbum ou Artista (ex: Hybrid Theory, Daft Punk, Charlie Brown Jr)..."
                  className="flex-1 px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-600 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-sky-400"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={isSearching || !searchQuery.trim()}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-b from-[#4facfe] to-[#1a5fb4] text-white text-xs font-extrabold flex items-center gap-2 disabled:opacity-50"
                >
                  {isSearching ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  <span>Buscar na API de Música</span>
                </button>
              </form>

              {isLoadingAlbumTracks && (
                <div className="p-8 text-center text-sky-300 flex items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Carregando capa HD e faixas oficiais do disco...</span>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {searchResults.map((album) => (
                  <div
                    key={album.albumId}
                    onClick={() => handleSelectAlbumToRank(album.albumId)}
                    className="group rounded-xl bg-slate-900/90 border border-slate-700 hover:border-sky-400 p-3 cursor-pointer flex flex-col justify-between transition-all hover:-translate-y-0.5 shadow-md"
                  >
                    <div>
                      <div className="aspect-square rounded-lg overflow-hidden bg-slate-950 mb-2.5 border border-slate-700">
                        <img
                          src={album.artworkUrl}
                          alt={album.albumName}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      </div>
                      <h4 className="text-xs font-bold text-white line-clamp-2">
                        {album.albumName}
                      </h4>
                      <p className="text-[11px] text-sky-300 truncate mt-0.5">
                        {album.artistName}
                      </p>
                    </div>
                    <div className="mt-2 pt-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
                      <span>{album.releaseYear || 'Álbum'}</span>
                      <span>{album.trackCount} faixas</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Passo 2: Ordenar Faixas (1ª Favorita até Última), Dar Nota 1-5 Estrelas e Comentário */
            <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Coluna Esquerda: Capa, Nota de 1 a 5 Estrelas (Meias-Estrelas), Comentário e Salvar */}
              <div className="lg:col-span-5 space-y-4">
                <div className="p-5 rounded-2xl bg-slate-900/95 border border-slate-700 space-y-4 shadow-xl">
                  <div className="flex gap-4 items-center">
                    <img
                      src={editingAlbum.artworkUrl}
                      alt={editingAlbum.albumName}
                      className="w-28 h-28 rounded-xl object-cover border-2 border-slate-600 shadow-md shrink-0"
                    />
                    <div className="min-w-0">
                      <span className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400 text-sky-300 text-[10px] font-bold">
                        RANKING DE {currentUser.toUpperCase()}
                      </span>
                      <h2 className="text-lg font-extrabold text-white mt-1 leading-snug">
                        {editingAlbum.albumName}
                      </h2>
                      <p className="text-xs text-sky-300 font-semibold">
                        {editingAlbum.artistName}{' '}
                        {editingAlbum.releaseYear ? `• ${editingAlbum.releaseYear}` : ''}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          handleQueueAlbumInDjBot(
                            editingAlbum.albumName,
                            editingAlbum.artistName,
                            editingAlbum.tracks
                          )
                        }
                        className="mt-2 px-2.5 py-1 rounded bg-[#163016] hover:bg-[#204520] border border-[#76ff03]/60 text-[#76ff03] text-[11px] font-bold flex items-center gap-1"
                      >
                        <Headphones className="w-3.5 h-3.5" />
                        <span>🎧 Ouvir Álbum Juntos no DJ Bot</span>
                      </button>
                    </div>
                  </div>

                  {/* Componente de 5 Estrelas com suporte a Meias-Estrelas */}
                  <div className="pt-3 border-t border-slate-800 space-y-1.5">
                    <label className="block text-xs font-bold text-slate-200">
                      Sua Nota (Suporta Meias-Estrelas 0.5 a 5.0):
                    </label>
                    <div className="flex items-center justify-between bg-slate-950 p-3 rounded-xl border border-slate-800">
                      <HalfStarRating
                        value={myRating}
                        onChange={(val) => setMyRating(val)}
                        size="lg"
                      />
                      <input
                        type="number"
                        step="0.5"
                        min="0.5"
                        max="5.0"
                        value={myRating}
                        onChange={(e) =>
                          setMyRating(
                            Math.max(0.5, Math.min(5.0, Number(e.target.value) || 0.5))
                          )
                        }
                        className="w-16 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-center text-xs font-bold text-amber-300"
                      />
                    </div>
                  </div>

                  {/* Comentário / Resenha sobre o Álbum */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-bold text-slate-200">
                      Seu Comentário / Resenha sobre o Álbum:
                    </label>
                    <textarea
                      rows={4}
                      value={myComment}
                      onChange={(e) => setMyComment(e.target.value)}
                      placeholder={`Escreva o que você achou desse álbum, melhor riff, faixa mais marcante...`}
                      className="w-full p-3 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 resize-none"
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setEditingAlbum(null)}
                      className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-slate-300"
                    >
                      Trocar Álbum
                    </button>
                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={handleSaveRanking}
                      className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-b from-[#52b700] to-[#347800] hover:brightness-110 border border-[#8cff32] text-white text-xs font-extrabold shadow-lg flex items-center justify-center gap-2"
                    >
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      <span>Salvar Ranking de {currentUser}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Coluna Direita: Ordenação Drag-and-Drop (1ª Favorita até Última) + Preview de 30s */}
              <div className="lg:col-span-7 flex flex-col">
                <div className="p-5 rounded-2xl bg-slate-900/95 border border-slate-700 flex-1 flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="text-sm font-extrabold text-white">
                        Ordene as Faixas: da 1ª (Favorita) até a {orderedTracks.length}ª
                      </h3>
                      <p className="text-[11px] text-slate-400">
                        Arraste as músicas (Drag-and-Drop) ou use as setas ▲/▼. Clique no Play para
                        ouvir 30s de preview!
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1.5 overflow-y-auto max-h-[520px] pr-1">
                    {orderedTracks.map((track, idx) => {
                      const isTop3 = idx < 3
                      const isPlayingThis = playingPreviewTrackId === track.trackId
                      return (
                        <div
                          key={track.trackId}
                          draggable
                          onDragStart={() => setDraggedIndex(idx)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            if (draggedIndex !== null && draggedIndex !== idx) {
                              moveTrack(draggedIndex, idx)
                            }
                            setDraggedIndex(null)
                          }}
                          className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border cursor-grab active:cursor-grabbing transition-all ${
                            isTop3
                              ? 'bg-gradient-to-r from-amber-500/20 via-slate-900 to-slate-900 border-amber-400/70'
                              : 'bg-slate-950/80 border-slate-800 hover:border-slate-600'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <GripVertical className="w-4 h-4 text-slate-500 shrink-0" />
                            <span
                              className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-extrabold shrink-0 ${
                                isTop3
                                  ? 'bg-amber-400 text-slate-950 shadow'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {idx + 1}º
                            </span>
                            <div className="min-w-0 flex-1">
                              <div
                                className={`text-xs font-bold truncate ${
                                  isTop3 ? 'text-amber-300' : 'text-slate-100'
                                }`}
                              >
                                {track.trackName}
                              </div>
                              <div className="text-[10px] text-slate-500">
                                Faixa original #{track.trackNumber}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {track.previewUrl && (
                              <button
                                type="button"
                                onClick={() => toggleTrackPreview(track)}
                                className={`px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 border ${
                                  isPlayingThis
                                    ? 'bg-[#76ff03] text-slate-950 border-[#76ff03]'
                                    : 'bg-slate-800 text-slate-200 border-slate-600 hover:bg-slate-700'
                                }`}
                                title="Ouvir preview oficial de 30s"
                              >
                                {isPlayingThis ? (
                                  <Pause className="w-3 h-3" />
                                ) : (
                                  <Play className="w-3 h-3" />
                                )}
                                <span>30s</span>
                              </button>
                            )}

                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveTrack(idx, idx - 1)}
                              className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30"
                              title="Subir posição"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === orderedTracks.length - 1}
                              onClick={() => moveTrack(idx, idx + 1)}
                              className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30"
                              title="Descer posição"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* ==================================================================== */}
      {/* SUB-VISÃO 3: TELA DE COMPARAÇÃO LADO A LADO (VITINHO VS WILL)         */}
      {/* ==================================================================== */}
      {subView === 'compare' && selectedComparison && (
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          {(() => {
            const album = selectedComparison
            const trackMap = new Map(
              (album.tracks_metadata || []).map((t) => [t.trackId, t])
            )
            const vitinhoOrder = album.vitinho_track_order || []
            const willOrder = album.will_track_order || []
            const compatibility = calculateCompatibilityPercentage(
              vitinhoOrder,
              willOrder
            )

            return (
              <div className="max-w-6xl mx-auto space-y-6">
                {/* Cabeçalho Grande com Capa, Data e Porcentagem de Compatibilidade (%) */}
                <div className="p-5 rounded-2xl bg-gradient-to-r from-[#172847] via-[#1c3259] to-[#172847] border-2 border-[#4878c0] shadow-2xl flex flex-wrap items-center justify-between gap-6">
                  <div className="flex items-center gap-5">
                    <img
                      src={album.artwork_url}
                      alt={album.album_name}
                      className="w-28 h-28 rounded-2xl object-cover border-2 border-amber-300 shadow-xl"
                    />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-0.5 rounded-full bg-sky-500/20 border border-sky-400 text-sky-300 text-[11px] font-bold">
                          📅 Rankeado em{' '}
                          {formatDateBr(
                            album.updated_at ||
                              album.vitinho_ranked_at ||
                              album.will_ranked_at
                          )}
                        </span>
                      </div>
                      <h2 className="text-2xl font-extrabold text-white">
                        {album.album_name}
                      </h2>
                      <p className="text-sm text-sky-300 font-bold">
                        {album.artist_name}{' '}
                        {album.release_year ? `(${album.release_year})` : ''}
                      </p>

                      <div className="pt-1 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleQueueAlbumInDjBot(
                              album.album_name,
                              album.artist_name,
                              album.tracks_metadata || []
                            )
                          }
                          className="px-3 py-1.5 rounded-lg bg-[#193319] hover:bg-[#244b24] border border-[#76ff03] text-[#76ff03] text-xs font-bold flex items-center gap-1.5"
                        >
                          <Headphones className="w-3.5 h-3.5" />
                          <span>🎧 Ouvir Álbum Juntos no DJ Bot</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSelectAlbumToRank(album.album_id, album)}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-500 text-xs font-bold text-white flex items-center gap-1.5"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Editar Meu Ranking ({currentUser})</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Medidor de Compatibilidade Musical (%) */}
                  <div className="px-6 py-4 rounded-2xl bg-slate-950/85 border-2 border-amber-400/80 text-center min-w-[230px] shadow-xl">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-extrabold text-amber-300 uppercase tracking-wider">
                      <Sparkles className="w-4 h-4" />
                      <span>Compatibilidade Musical</span>
                    </div>
                    {compatibility !== null ? (
                      <>
                        <div className="text-4xl font-black text-white my-1">
                          {compatibility}%
                        </div>
                        <div className="text-[11px] text-slate-300">
                          {compatibility >= 80
                            ? '🔥 Sintonia Absurda!'
                            : compatibility >= 55
                              ? '🎵 Gostos Parecidos!'
                              : '⚡ Opiniões Bem Diferentes!'}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-slate-400 py-3">
                        Aguardando os dois amigos votarem para calcular a %
                      </div>
                    )}
                  </div>
                </div>

                {/* Duas Colunas Lado a Lado: Esquerda (Vitinho) vs Direita (Will) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* COLUNA ESQUERDA: RANKING DO VITINHO */}
                  <div className="rounded-2xl bg-slate-900/95 border-2 border-sky-500/50 p-5 space-y-4 shadow-xl">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div>
                        <h3 className="text-base font-extrabold text-sky-300">
                          👑 Ranking do Vitinho
                        </h3>
                        <span className="text-[11px] text-slate-400">
                          Avaliado em {formatDateBr(album.vitinho_ranked_at)}
                        </span>
                      </div>
                      <HalfStarRating
                        value={Number(album.vitinho_rating || 0)}
                        readOnly
                        size="md"
                      />
                    </div>

                    {album.vitinho_comment && (
                      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 italic">
                        &ldquo;{album.vitinho_comment}&rdquo;
                      </div>
                    )}

                    {vitinhoOrder.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-500">
                        Vitinho ainda não rankeou este álbum.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {vitinhoOrder.map((trackId, vitIdx) => {
                          const track = trackMap.get(trackId)
                          if (!track) return null
                          const isTop3 = vitIdx < 3
                          const willIdx = willOrder.indexOf(trackId)
                          const diff =
                            willIdx !== -1 ? willIdx - vitIdx : null

                          return (
                            <div
                              key={trackId}
                              className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border ${
                                isTop3
                                  ? 'bg-gradient-to-r from-amber-500/25 via-amber-500/10 to-slate-950 border-amber-400 shadow-sm'
                                  : 'bg-slate-950/75 border-slate-800'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span
                                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black shrink-0 ${
                                    isTop3
                                      ? 'bg-amber-400 text-slate-950'
                                      : 'bg-slate-800 text-slate-300'
                                  }`}
                                >
                                  {vitIdx + 1}º
                                </span>
                                <span
                                  className={`text-xs font-bold truncate ${
                                    isTop3 ? 'text-amber-200' : 'text-slate-200'
                                  }`}
                                >
                                  {track.trackName}
                                </span>
                              </div>

                              {/* Indicador Visual de Comparação com a lista do Will */}
                              {diff !== null && (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0 ${
                                    diff === 0
                                      ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-300'
                                      : diff > 0
                                        ? 'bg-sky-500/20 border border-sky-400 text-sky-300'
                                        : 'bg-rose-500/20 border border-rose-400 text-rose-300'
                                  }`}
                                >
                                  {diff === 0
                                    ? '🎯 Match Exato!'
                                    : diff > 0
                                      ? `▲ +${diff}`
                                      : `▼ ${diff}`}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* COLUNA DIREITA: RANKING DO WILL */}
                  <div className="rounded-2xl bg-slate-900/95 border-2 border-emerald-500/50 p-5 space-y-4 shadow-xl">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div>
                        <h3 className="text-base font-extrabold text-emerald-300">
                          👑 Ranking do Will
                        </h3>
                        <span className="text-[11px] text-slate-400">
                          Avaliado em {formatDateBr(album.will_ranked_at)}
                        </span>
                      </div>
                      <HalfStarRating
                        value={Number(album.will_rating || 0)}
                        readOnly
                        size="md"
                      />
                    </div>

                    {album.will_comment && (
                      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 italic">
                        &ldquo;{album.will_comment}&rdquo;
                      </div>
                    )}

                    {willOrder.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-500">
                        Will ainda não rankeou este álbum.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {willOrder.map((trackId, willIdx) => {
                          const track = trackMap.get(trackId)
                          if (!track) return null
                          const isTop3 = willIdx < 3
                          const vitIdx = vitinhoOrder.indexOf(trackId)
                          const diff =
                            vitIdx !== -1 ? vitIdx - willIdx : null

                          return (
                            <div
                              key={trackId}
                              className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border ${
                                isTop3
                                  ? 'bg-gradient-to-r from-amber-500/25 via-amber-500/10 to-slate-950 border-amber-400 shadow-sm'
                                  : 'bg-slate-950/75 border-slate-800'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span
                                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black shrink-0 ${
                                    isTop3
                                      ? 'bg-amber-400 text-slate-950'
                                      : 'bg-slate-800 text-slate-300'
                                  }`}
                                >
                                  {willIdx + 1}º
                                </span>
                                <span
                                  className={`text-xs font-bold truncate ${
                                    isTop3 ? 'text-amber-200' : 'text-slate-200'
                                  }`}
                                >
                                  {track.trackName}
                                </span>
                              </div>

                              {/* Indicador Visual de Comparação com a lista do Vitinho */}
                              {diff !== null && (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0 ${
                                    diff === 0
                                      ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-300'
                                      : diff > 0
                                        ? 'bg-sky-500/20 border border-sky-400 text-sky-300'
                                        : 'bg-rose-500/20 border border-rose-400 text-rose-300'
                                  }`}
                                >
                                  {diff === 0
                                    ? '🎯 Match Exato!'
                                    : diff > 0
                                      ? `▲ +${diff}`
                                      : `▼ ${diff}`}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}
        </main>
      )}
    </div>
  )
}
