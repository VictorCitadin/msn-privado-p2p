declare module 'yt-search' {
  export interface VideoSearchResult {
    videoId: string
    title: string
    seconds: number
    thumbnail: string
    author?: {
      name: string
    }
  }

  export interface VideoMetadataResult {
    videoId: string
    title: string
    seconds: number
    thumbnail: string
    author?: {
      name: string
    }
  }

  export interface SearchResult {
    videos: VideoSearchResult[]
  }

  function ytSearch(query: string): Promise<SearchResult>
  function ytSearch(options: { videoId: string }): Promise<VideoMetadataResult>
  export default ytSearch
}

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_VERCEL_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
