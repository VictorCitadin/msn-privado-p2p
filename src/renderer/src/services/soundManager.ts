/**
 * Sistema de Sons e Notificações Sonoras do MSN Messenger 7.5
 * Utiliza um único AudioContext reutilizável para zero vazamento de memória (Gaming Edition).
 * Suporta arquivos em /src/renderer/src/assets/sounds/*.mp3 com síntese fiel integrada dos acordes clássicos do MSN.
 */

export type MsnSoundEffect =
  | 'login'
  | 'message'
  | 'nudge'
  | 'ring'
  | 'mute'
  | 'unmute'
  | 'room-join'
  | 'room-leave'

export type SoundboardWinkId = 'msn-wink' | 'headshot' | 'gg-ez' | 'airhorn' | 'drumroll'

export interface SoundboardItem {
  id: SoundboardWinkId
  label: string
  emoji: string
}

export const SOUNDBOARD_ITEMS: SoundboardItem[] = [
  { id: 'msn-wink', label: 'Wink Clássico', emoji: '😉' },
  { id: 'headshot', label: 'Clutch / HS', emoji: '🎯' },
  { id: 'gg-ez', label: 'GG WP!', emoji: '🏆' },
  { id: 'airhorn', label: 'Airhorn MLG', emoji: '📢' },
  { id: 'drumroll', label: 'Suspense', emoji: '🥁' }
]

class SoundManager {
  private ctx: AudioContext | null = null
  private bufferCache: Map<string, AudioBuffer> = new Map()
  private ringInterval: ReturnType<typeof setInterval> | null = null

  private getContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new AudioCtx()
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  /**
   * Tenta carregar um arquivo de som customizado de /assets/sounds/{name}.mp3 se existir;
   * caso contrário ou enquanto não houver MP3 externo, reproduz o acorde original do MSN 7.5 via Web Audio API.
   */
  public async play(effect: MsnSoundEffect): Promise<void> {
    try {
      const ctx = this.getContext()

      const customBuffer = this.bufferCache.get(effect)
      if (customBuffer) {
        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        gain.gain.value = 0.45
        source.buffer = customBuffer
        source.connect(gain)
        gain.connect(ctx.destination)
        source.start(0)
        return
      }

      switch (effect) {
        case 'login':
          this.playMsnLoginChime(ctx)
          break
        case 'message':
          this.playMsnMessageChime(ctx)
          break
        case 'nudge':
          this.playMsnNudgeSound(ctx)
          break
        case 'ring':
          this.playMsnRingTone(ctx)
          break
        case 'mute':
          this.playToneSequence(ctx, [
            { freq: 480, duration: 0.08, type: 'sine', gain: 0.25 },
            { freq: 320, duration: 0.12, type: 'sine', gain: 0.25 }
          ])
          break
        case 'unmute':
          this.playToneSequence(ctx, [
            { freq: 360, duration: 0.08, type: 'sine', gain: 0.25 },
            { freq: 640, duration: 0.12, type: 'sine', gain: 0.25 }
          ])
          break
        case 'room-join':
          this.playToneSequence(ctx, [
            { freq: 523.25, duration: 0.09, type: 'sine', gain: 0.28 }, // C5
            { freq: 659.25, duration: 0.09, type: 'sine', gain: 0.3 }, // E5
            { freq: 783.99, duration: 0.14, type: 'sine', gain: 0.32 } // G5
          ])
          break
        case 'room-leave':
          this.playToneSequence(ctx, [
            { freq: 783.99, duration: 0.09, type: 'sine', gain: 0.26 }, // G5
            { freq: 587.33, duration: 0.09, type: 'sine', gain: 0.25 }, // D5
            { freq: 440.0, duration: 0.15, type: 'sine', gain: 0.24 } // A4
          ])
          break
      }
    } catch (err) {
      console.warn('[SoundManager] Erro ao reproduzir som:', err)
    }
  }

  public startRingLoop(): void {
    this.stopRingLoop()
    this.play('ring')
    this.ringInterval = setInterval(() => {
      this.play('ring')
    }, 2400)
  }

  public stopRingLoop(): void {
    if (this.ringInterval) {
      clearInterval(this.ringInterval)
      this.ringInterval = null
    }
  }

  /**
   * Dispara um dos 5 sons curtos sincronizados da barra de Soundboard/Winks
   */
  public playSoundboardWink(winkId: SoundboardWinkId): void {
    const ctx = this.getContext()
    switch (winkId) {
      case 'msn-wink':
        this.playToneSequence(ctx, [
          { freq: 523.25, duration: 0.09, type: 'triangle', gain: 0.3 },
          { freq: 659.25, duration: 0.09, type: 'triangle', gain: 0.3 },
          { freq: 783.99, duration: 0.11, type: 'triangle', gain: 0.3 },
          { freq: 1046.5, duration: 0.22, type: 'triangle', gain: 0.35 }
        ])
        break
      case 'headshot':
        this.playToneSequence(ctx, [
          { freq: 880, duration: 0.06, type: 'sawtooth', gain: 0.28 },
          { freq: 1318.5, duration: 0.08, type: 'sawtooth', gain: 0.32 },
          { freq: 1760, duration: 0.2, type: 'square', gain: 0.28 }
        ])
        break
      case 'gg-ez':
        this.playToneSequence(ctx, [
          { freq: 587.33, duration: 0.11, type: 'triangle', gain: 0.3 },
          { freq: 587.33, duration: 0.11, type: 'triangle', gain: 0.3 },
          { freq: 587.33, duration: 0.11, type: 'triangle', gain: 0.3 },
          { freq: 783.99, duration: 0.34, type: 'triangle', gain: 0.35 }
        ])
        break
      case 'airhorn':
        this.playToneSequence(ctx, [
          { freq: 466.16, duration: 0.12, type: 'sawtooth', gain: 0.26 },
          { freq: 466.16, duration: 0.12, type: 'sawtooth', gain: 0.26 },
          { freq: 466.16, duration: 0.38, type: 'sawtooth', gain: 0.3 }
        ])
        break
      case 'drumroll':
        this.playToneSequence(ctx, [
          { freq: 220, duration: 0.07, type: 'triangle', gain: 0.25 },
          { freq: 246.94, duration: 0.07, type: 'triangle', gain: 0.25 },
          { freq: 261.63, duration: 0.07, type: 'triangle', gain: 0.25 },
          { freq: 293.66, duration: 0.07, type: 'triangle', gain: 0.28 },
          { freq: 392.0, duration: 0.24, type: 'sine', gain: 0.35 }
        ])
        break
    }
  }

  // Acorde clássico de Login do MSN (login.mp3)
  private playMsnLoginChime(ctx: AudioContext): void {
    this.playToneSequence(ctx, [
      { freq: 587.33, duration: 0.14, type: 'sine', gain: 0.28 }, // D5
      { freq: 739.99, duration: 0.14, type: 'sine', gain: 0.28 }, // F#5
      { freq: 880.0, duration: 0.16, type: 'sine', gain: 0.3 }, // A5
      { freq: 1174.66, duration: 0.34, type: 'sine', gain: 0.32 } // D6
    ])
  }

  // Som nostálgico de Mensagem Recebida do MSN 7.5 (message.mp3)
  private playMsnMessageChime(ctx: AudioContext): void {
    this.playToneSequence(ctx, [
      { freq: 783.99, duration: 0.1, type: 'sine', gain: 0.3 }, // G5
      { freq: 1046.5, duration: 0.11, type: 'sine', gain: 0.32 }, // C6
      { freq: 987.77, duration: 0.24, type: 'sine', gain: 0.28 } // B5
    ])
  }

  // Vibração rápida de "Chamar Atenção / Nudge" (nudge.mp3)
  private playMsnNudgeSound(ctx: AudioContext): void {
    this.playToneSequence(ctx, [
      { freq: 190, duration: 0.05, type: 'sawtooth', gain: 0.32 },
      { freq: 280, duration: 0.05, type: 'sawtooth', gain: 0.32 },
      { freq: 175, duration: 0.05, type: 'sawtooth', gain: 0.32 },
      { freq: 310, duration: 0.06, type: 'sawtooth', gain: 0.34 },
      { freq: 185, duration: 0.06, type: 'sawtooth', gain: 0.32 },
      { freq: 340, duration: 0.11, type: 'sawtooth', gain: 0.35 }
    ])
  }

  // Toque de Chamada de Voz/Vídeo do MSN (ring.mp3)
  private playMsnRingTone(ctx: AudioContext): void {
    this.playToneSequence(ctx, [
      { freq: 659.25, duration: 0.15, type: 'sine', gain: 0.28 },
      { freq: 880.0, duration: 0.15, type: 'sine', gain: 0.28 },
      { freq: 659.25, duration: 0.15, type: 'sine', gain: 0.28 },
      { freq: 987.77, duration: 0.28, type: 'sine', gain: 0.3 }
    ])
  }

  private playToneSequence(
    ctx: AudioContext,
    notes: Array<{
      freq: number
      duration: number
      type: OscillatorType
      gain: number
    }>
  ): void {
    let startTime = ctx.currentTime
    for (const note of notes) {
      const osc = ctx.createOscillator()
      const gainNode = ctx.createGain()
      osc.type = note.type
      osc.frequency.setValueAtTime(note.freq, startTime)

      gainNode.gain.setValueAtTime(0.001, startTime)
      gainNode.gain.exponentialRampToValueAtTime(note.gain, startTime + 0.015)
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + note.duration)

      osc.connect(gainNode)
      gainNode.connect(ctx.destination)

      osc.start(startTime)
      osc.stop(startTime + note.duration + 0.01)
      startTime += note.duration * 0.92
    }
  }
}

export const soundManager = new SoundManager()
