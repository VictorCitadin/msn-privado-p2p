-- ============================================================================
-- SCHEMA SQL COMPLETO PARA O SUPABASE (PostgreSQL + Realtime)
-- MSN Messenger Privado P2P + WMP DJ Bot + Album Ranker (Vitinho & Will)
-- ============================================================================

-- 1. Extensão para geração de UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tabela Principal: album_rankings
-- Armazena as avaliações, notas (0.5 a 5.0 com meias-estrelas), comentários e
-- a ordem exata das faixas de cada álbum avaliado por Vitinho e Will.
CREATE TABLE IF NOT EXISTS public.album_rankings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  album_id TEXT NOT NULL UNIQUE,
  album_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  artwork_url TEXT NOT NULL,
  release_year TEXT,
  tracks_metadata JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Avaliação do Vitinho
  vitinho_rating NUMERIC(2,1) CHECK (vitinho_rating >= 0.5 AND vitinho_rating <= 5.0),
  vitinho_comment TEXT,
  vitinho_track_order JSONB DEFAULT '[]'::jsonb,
  vitinho_ranked_at TIMESTAMPTZ,

  -- Avaliação do Will
  will_rating NUMERIC(2,1) CHECK (will_rating >= 0.5 AND will_rating <= 5.0),
  will_comment TEXT,
  will_track_order JSONB DEFAULT '[]'::jsonb,
  will_ranked_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Tabela opcional de fila/histórico de sinalização fallback (caso queira persistir eventos)
CREATE TABLE IF NOT EXISTS public.rtc_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id TEXT NOT NULL DEFAULT 'msn-vitinho-will',
  sender TEXT NOT NULL CHECK (sender IN ('Vitinho', 'Will')),
  target TEXT NOT NULL CHECK (target IN ('Vitinho', 'Will')),
  signal_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Índices de Performance
CREATE INDEX IF NOT EXISTS idx_album_rankings_album_id ON public.album_rankings(album_id);
CREATE INDEX IF NOT EXISTS idx_album_rankings_updated_at ON public.album_rankings(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rtc_signals_room_target ON public.rtc_signals(room_id, target, created_at DESC);

-- 5. Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_album_rankings_updated_at ON public.album_rankings;
CREATE TRIGGER trg_album_rankings_updated_at
BEFORE UPDATE ON public.album_rankings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Row Level Security (RLS) - Aberto para a chave anon/service do app privado
ALTER TABLE public.album_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rtc_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acesso total privado Vitinho e Will em album_rankings" ON public.album_rankings;
CREATE POLICY "Acesso total privado Vitinho e Will em album_rankings"
  ON public.album_rankings
  FOR ALL
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso total privado Vitinho e Will em rtc_signals" ON public.rtc_signals;
CREATE POLICY "Acesso total privado Vitinho e Will em rtc_signals"
  ON public.rtc_signals
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 7. Habilitar Supabase Realtime para sincronização instantânea
ALTER PUBLICATION supabase_realtime ADD TABLE public.album_rankings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rtc_signals;
