import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null

/**
 * API Route da Vercel: /api/signal
 * Gerencia Handshake WebRTC (SDP Offer, SDP Answer, ICE Candidates) e eventos de presença
 * entre Vitinho e Will usando Supabase Realtime Broadcast + Persistência em rtc_signals.
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
    if (req.method === 'POST') {
      const {
        roomId = 'msn-vitinho-will',
        sender,
        target,
        type,
        payload
      } = req.body as {
        roomId?: string
        sender: 'Vitinho' | 'Will'
        target: 'Vitinho' | 'Will'
        type: 'sdp-offer' | 'sdp-answer' | 'ice-candidate' | 'hangup' | 'presence-ping'
        payload: Record<string, unknown>
      }

      if (!sender || !target || !type) {
        return res.status(400).json({
          ok: false,
          error: 'Campos obrigatórios: sender, target, type'
        })
      }

      // 1. Grava o sinal na tabela rtc_signals (dispara postgres_changes no Supabase Realtime e serve como fila resiliente)
      const { data, error } = await supabase
        .from('rtc_signals')
        .insert({
          room_id: roomId,
          sender,
          target,
          signal_type: type,
          payload: payload || {}
        })
        .select()
        .single()

      if (error) {
        return res.status(500).json({ ok: false, error: error.message })
      }

      // 2. Limpa sinais antigos (> 5 minutos) para manter o banco gratuito enxuto
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      await supabase.from('rtc_signals').delete().lt('created_at', fiveMinutesAgo)

      return res.status(200).json({ ok: true, signal: data })
    }

    if (req.method === 'GET') {
      const target = req.query.target as string
      const roomId = (req.query.roomId as string) || 'msn-vitinho-will'
      const since = req.query.since as string | undefined

      if (!target) {
        return res.status(400).json({ ok: false, error: 'Parâmetro target é obrigatório.' })
      }

      let query = supabase
        .from('rtc_signals')
        .select('*')
        .eq('room_id', roomId)
        .eq('target', target)
        .order('created_at', { ascending: true })
        .limit(50)

      if (since) {
        query = query.gt('created_at', since)
      }

      const { data, error } = await query
      if (error) {
        return res.status(500).json({ ok: false, error: error.message })
      }

      return res.status(200).json({ ok: true, signals: data || [] })
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro interno em /api/signal'
    return res.status(500).json({ ok: false, error: message })
  }
}
