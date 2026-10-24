# MSN Messenger Privado P2P + WMP DJ Bot + Album Ranker (Ultra-Lightweight Gaming Edition)

Aplicativo desktop exclusivo para Windows criado para **Vitinho** e **Will**, recriando a estética nostálgica do **MSN Messenger 7.5 / Windows Live Messenger 2009** e **Windows Media Player 9/10**, com **WebRTC P2P Direto (Codec H.264 NVENC/AMF/QuickSync)**, **Zero Eco (PulseaudioLoopback)**, **DJ Bot com Auto-Ducking** e uma **Segunda Janela Dedicada para o Rankeador de Álbuns** sincronizada na nuvem via **Vercel + Supabase**.

---

## Como Rodar e Compilar

### 1. Instalar dependências
```bash
cd "C:\Users\VictorCitadin\Desktop\projetos\msn-privado-p2p"
npm install
```

### 2. Configurar `.env` e Banco Supabase
1. Crie um projeto gratuito no [Supabase](https://supabase.com) e cole o conteúdo de `supabase/schema.sql` no **SQL Editor** do painel do Supabase.
2. Edite o arquivo `.env` na raiz do projeto com seu `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
3. Para publicar as rotas serverless `/api/signal` e `/api/rankings` na Vercel:
   ```bash
   npx vercel --prod
   ```

### 3. Executar em Modo Desenvolvimento
```bash
npm run dev
```

### 4. Gerar Instalador `.exe` Otimizado para Windows (x64)
```bash
npm run build:win
```
