import React, { useEffect, useState } from 'react'
import { Monitor, AppWindow, Volume2, X, RefreshCw } from 'lucide-react'
import type { DesktopSourceItem } from '../../../preload/index'

interface ScreenShareModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectSource: (sourceId: string, includeSystemAudio: boolean) => void
}

export const ScreenShareModal: React.FC<ScreenShareModalProps> = ({
  isOpen,
  onClose,
  onSelectSource
}) => {
  const [sources, setSources] = useState<DesktopSourceItem[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [filterTab, setFilterTab] = useState<'all' | 'screen' | 'window'>('all')
  const [includeAudio, setIncludeAudio] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(false)

  const loadSources = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.msnApi.getDesktopSources()
      setSources(list)
      // Mantém a seleção apenas se a janela/tela ainda existir (ex: jogo fechado desde a última vez)
      setSelectedId((prev) => (list.some((src) => src.id === prev) ? prev : list[0]?.id || ''))
    } catch (err) {
      console.error('[ScreenShareModal] Erro ao listar janelas/telas:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadSources()
    }
  }, [isOpen])

  if (!isOpen) return null

  const filteredSources = sources.filter((src) => {
    if (filterTab === 'screen') return src.isScreen
    if (filterTab === 'window') return !src.isScreen
    return true
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4">
      <div className="w-full max-w-3xl rounded-xl border-2 border-[#4b91d1] bg-[#eef6ff] shadow-2xl overflow-hidden flex flex-col max-h-[86vh]">
        {/* Cabeçalho MSN Aero */}
        <div className="msn-header-gradient px-4 py-2.5 flex items-center justify-between text-white">
          <div className="flex items-center gap-2">
            <Monitor className="w-4 h-4" />
            <span className="font-bold text-sm tracking-wide">
              Compartilhar Tela ou Jogo (10 Mbps @ 60 FPS — Codec H.264 NVENC)
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/20 transition-colors"
            title="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Abas de Filtro */}
        <div className="px-4 py-2.5 bg-[#dcecfc] border-b border-[#9abce0] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFilterTab('all')}
              className={`px-3 py-1 rounded text-xs font-bold border ${
                filterTab === 'all'
                  ? 'bg-[#2664a5] text-white border-[#1b4b7e]'
                  : 'msn-btn-aero text-slate-700'
              }`}
            >
              Tudo ({sources.length})
            </button>
            <button
              onClick={() => setFilterTab('screen')}
              className={`px-3 py-1 rounded text-xs font-bold border flex items-center gap-1.5 ${
                filterTab === 'screen'
                  ? 'bg-[#2664a5] text-white border-[#1b4b7e]'
                  : 'msn-btn-aero text-slate-700'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              Telas Inteiras
            </button>
            <button
              onClick={() => setFilterTab('window')}
              className={`px-3 py-1 rounded text-xs font-bold border flex items-center gap-1.5 ${
                filterTab === 'window'
                  ? 'bg-[#2664a5] text-white border-[#1b4b7e]'
                  : 'msn-btn-aero text-slate-700'
              }`}
            >
              <AppWindow className="w-3.5 h-3.5" />
              Janelas / Jogos Específicos
            </button>
          </div>

          <button
            onClick={loadSources}
            className="msn-btn-aero px-2.5 py-1 rounded text-xs font-semibold text-slate-700 flex items-center gap-1"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>

        {/* Grade de Miniaturas */}
        <div className="p-4 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-3 flex-1">
          {filteredSources.map((src) => {
            const isSelected = src.id === selectedId
            return (
              <button
                key={src.id}
                type="button"
                onClick={() => setSelectedId(src.id)}
                onDoubleClick={() => onSelectSource(src.id, includeAudio)}
                className={`group rounded-lg p-2 border-2 text-left transition-all flex flex-col justify-between ${
                  isSelected
                    ? 'border-[#2664a5] bg-[#d4e9ff] shadow-md ring-2 ring-[#4b91d1]/40'
                    : 'border-[#b3cfea] bg-white hover:border-[#689fd4]'
                }`}
              >
                <div className="relative w-full aspect-video rounded overflow-hidden bg-slate-900 mb-2 border border-slate-300">
                  <img
                    src={src.thumbnailDataUrl}
                    alt={src.name}
                    className="w-full h-full object-contain"
                  />
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-black/75 text-white">
                    {src.isScreen ? 'TELA' : 'JANELA'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {src.appIconDataUrl ? (
                    <img src={src.appIconDataUrl} alt="" className="w-4 h-4 shrink-0" />
                  ) : src.isScreen ? (
                    <Monitor className="w-4 h-4 text-[#2664a5] shrink-0" />
                  ) : (
                    <AppWindow className="w-4 h-4 text-[#2664a5] shrink-0" />
                  )}
                  <span className="text-xs font-semibold text-slate-800 truncate">{src.name}</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Rodapé com Captura de Áudio Isolada (Zero Eco) */}
        <div className="px-4 py-3 bg-[#dcecfc] border-t border-[#9abce0] flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              className="w-4 h-4 accent-[#2664a5] rounded"
            />
            <Volume2 className="w-4 h-4 text-[#1d528d]" />
            <div className="text-xs">
              <span className="font-bold text-slate-800">
                Compartilhar Áudio do Filme / Jogo (Opus 510 kbps Stereo CBR)
              </span>
              <p className="text-[11px] text-slate-600">
                Isolamento PulseaudioLoopback ativo — não duplica a voz do seu amigo.
              </p>
            </div>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="msn-btn-aero px-3.5 py-1.5 rounded text-xs font-bold text-slate-700"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!selectedId}
              onClick={() => {
                if (selectedId) {
                  onSelectSource(selectedId, includeAudio)
                }
              }}
              className="px-4 py-1.5 rounded text-xs font-bold text-white bg-gradient-to-b from-[#52b700] to-[#3a8400] border border-[#2d6600] shadow hover:brightness-105 disabled:opacity-50"
            >
              Iniciar Transmissão (60 FPS)
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
