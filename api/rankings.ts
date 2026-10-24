import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null

export interface TrackItemPayload {
  trackId: string
  trackNumber: number
  trackName: string
  durationMs: number
  previewUrl?: string
}

export interface SaveRankingRequestBody {
  albumId: string
  albumName: string
  artistName: string
  artworkUrl: string
  releaseYear?: string
  tracksMetadata: TrackItemPayload[]
  user: 'Vitinho' | 'Will'
  rating: number
  comment: string
  trackOrder: string[] // Array de trackIds na ordem favorita do usuário (1º ao Nº)
}

/**
 * API Route da Vercel: /api/rankings
 * Sincroniza na nuvem (Supabase PostgreSQL) os rankings de álbuns das contas de Vitinho e Will.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (!supabase) {
    return res.status(503).json({
      ok: false,
      error: 'Supabase não configurado nas variáveis de ambiente da Vercel.'
    })
  }

  try {
    if (req.method === 'GET') {
      const albumId = req.query.albumId as string | undefined

      if (albumId) {
        const { data, error } = await supabase
          .from('album_rankings')
          .select('*')
          .eq('album_id', albumId)
          .maybeSingle()

        if (error) {
          return res.status(500).json({ ok: false, error: error.message })
        }
        return res.status(200).json({ ok: true, ranking: data })
      }

      const { data, error } = await supabase
        .from('album_rankings')
        .select('*')
        .order('updated_at', { ascending: false })

      if (error) {
        return res.status(500).json({ ok: false, error: error.message })
      }

      return res.status(200).json({ ok: true, rankings: data || [] })
    }

    if (req.method === 'POST') {
      const body = req.body as SaveRankingRequestBody
      const {
        albumId,
        albumName,
        artistName,
        artworkUrl,
        releaseYear,
        tracksMetadata,
        user,
        rating,
        comment,
        trackOrder
      } = body

      if (!albumId || !albumName || !artistName || !user || typeof rating !== 'number') {
        return res.status(400).json({
          ok: false,
          error: 'Parâmetros obrigatórios ausentes (albumId, albumName, artistName, user, rating).'
        })
      }

      const now = new Date().toISOString()

      // Verifica se o álbum já existe na tabela para preservar o voto do outro amigo
      const { data: existing } = await supabase
        .from('album_rankings')
        .select('*')
        .eq('album_id', albumId)
        .maybeSingle()

      const upsertPayload: Record<string, unknown> = {
        album_id: albumId,
        album_name: albumName,
        artist_name: artistName,
        artwork_url: artworkUrl,
        release_year: releaseYear || existing?.release_year || '',
        tracks_metadata:
          Array.isArray(tracksMetadata) && tracksMetadata.length > 0
            ? tracksMetadata
            : existing?.tracks_metadata || []
      }

      if (user === 'Vitinho') {
        upsertPayload.vitinho_rating = rating
        upsertPayload.vitinho_comment = comment
        upsertPayload.vitinho_track_order = trackOrder
        upsertPayload.vitinho_ranked_at = now
      } else {
        upsertPayload.will_rating = rating
        upsertPayload.will_comment = comment
        upsertPayload.will_track_order = trackOrder
        upsertPayload.will_ranked_at = now
      }

      const { data, error } = await supabase
        .from('album_rankings')
        .upsert(upsertPayload, { onConflict: 'album_id' })
        .select()
        .single()

      if (error) {
        return res.status(500).json({ ok: false, error: error.message })
      }

      return res.status(200).json({ ok: true, ranking: data })
    }

    if (req.method === 'DELETE') {
      const albumId = (req.query.albumId as string) || (req.body && req.body.albumId)
      if (!albumId) {
        return res.status(400).json({ ok: false, error: 'albumId é obrigatório para exclusão.' })
      }

      const { error } = await supabase.from('album_rankings').delete().eq('album_id', albumId)
      if (error) {
        return res.status(500).json({ ok: false, error: error.message })
      }

      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro interno em /api/rankings'
    return res.status(500).json({ ok: false, error: message })
  }
}
