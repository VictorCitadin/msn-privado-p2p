/**
 * Áudio do compartilhamento de tela (somente no app de PC/Electron):
 * - Captura nativa WASAPI por processo (loopback-capture.exe), que exclui o áudio do próprio app
 *   (onde a voz dos amigos toca) ou inclui só o processo da janela compartilhada.
 * - Fallback: cancelador adaptativo AudioWorklet que subtrai a voz dos amigos do loopback do Chromium.
 */

type MsnApi = Window['msnApi']

/** window.msnApi só existe no Electron; no app Android (Capacitor) ele não existe. */
export function getMsnApi(): MsnApi | undefined {
  return (window as unknown as { msnApi?: MsnApi }).msnApi
}

export class ScreenAudioCapture {
  private workletRegistered = false
  private unsubLoopbackAudio: (() => void) | null = null
  private loopbackAudioProcessor: ScriptProcessorNode | null = null
  private loopbackAudioDestNode: MediaStreamAudioDestinationNode | null = null
  private loopbackAudioGainNode: GainNode | null = null
  private loopbackAudioCompressorNode: DynamicsCompressorNode | null = null
  private loopbackAudioDummyNode: GainNode | null = null
  private cancellerSources: AudioNode[] = []
  private cancellerNode: AudioWorkletNode | null = null

  constructor(
    private getAudioContext: () => AudioContext,
    private getRemoteVoiceStreams: () => MediaStream[]
  ) {}

  /** Chamado quando o AudioContext é fechado/recriado */
  resetContext(): void {
    this.workletRegistered = false
  }

  private async ensureLoopbackCancellerWorklet(ctx: AudioContext): Promise<void> {
    if (this.workletRegistered) return
    const workletCode = `
      class VoiceLoopbackCancellerProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.ringSize = 32768;
          this.ringMask = this.ringSize - 1;
          this.refRing = new Float32Array(this.ringSize);
          this.writePos = 0;

          // Stage 1: Acumulador linear de fase exata a 12 kHz (decimação 4x) até 233ms (2800 bins)
          this.decimSize = 4096;
          this.decimMask = this.decimSize - 1;
          this.refDecim = new Float32Array(this.decimSize);
          this.decimPos = 0;
          this.accRef = 0;
          this.accDes = 0;
          this.maxCoarseBins = 2800;
          this.coarseCorr = new Float32Array(this.maxCoarseBins);
          this.coarseEnergy = 0;
          this.coarseSamples = 0;
          this.coarseReady = false;
          this.coarseCenter = 6800;

          // Stage 2: Correlação fina de 1 sample em [-16, +16] ao redor de coarseCenter
          this.fineRadius = 16;
          this.fineLen = this.fineRadius * 2 + 1;
          this.fineCorr = new Float32Array(this.fineLen);
          this.fineEnergy = 0;
          this.fineSamples = 0;

          // Stage 3: Micro-FIR adaptativo NLMS de 9 taps cravado no atraso exato do WASAPI Loopback (-55 dB de cancelamento)
          this.lockedLag = 6800;
          this.isLocked = false;
          this.wL = new Float32Array([0, 0, 0, 0, 1.0, 0, 0, 0, 0]);
          this.wR = new Float32Array([0, 0, 0, 0, 1.0, 0, 0, 0, 0]);
          this.sampleCount = 0;
        }

        process(inputs, outputs) {
          const desktopIn = inputs[0];
          const voiceRefIn = inputs[1];
          const out = outputs[0];
          if (!desktopIn || desktopIn.length === 0) return true;

          const inL = desktopIn[0];
          const inR = desktopIn[1] || desktopIn[0];
          const outL = out[0];
          const outR = out[1] || out[0];
          const refL = (voiceRefIn && voiceRefIn[0]) ? voiceRefIn[0] : null;
          const refR = (voiceRefIn && voiceRefIn[1]) ? voiceRefIn[1] : refL;
          const n = inL.length;

          for (let i = 0; i < n; i++) {
            const r = refL ? (refR ? (refL[i] + refR[i]) * 0.5 : refL[i]) : 0;
            const dL = inL[i];
            const dR = inR[i];
            const d = (dL + dR) * 0.5;
            this.refRing[this.writePos] = r;

            // Stage 1: Decimação linear 4x (12 kHz) imune a áudio de filme/jogo descorrelacionado
            this.accRef += r;
            this.accDes += d;
            if ((this.sampleCount & 3) === 3) {
              const rLP = this.accRef * 0.25;
              const dLP = this.accDes * 0.25;
              this.accRef = 0;
              this.accDes = 0;
              this.refDecim[this.decimPos] = rLP;

              if (!this.coarseReady) {
                const rEchoCheck = this.refDecim[(this.decimPos - 1650) & this.decimMask];
                if (rEchoCheck * rEchoCheck > 1e-6) {
                  this.coarseEnergy += rEchoCheck * rEchoCheck;
                  this.coarseSamples++;
                  for (let b = 200; b < this.maxCoarseBins; b++) {
                    this.coarseCorr[b] += dLP * this.refDecim[(this.decimPos - b) & this.decimMask];
                  }
                  if (this.coarseSamples >= 1800) {
                    let bestBin = 0;
                    let bestVal = -1e9;
                    for (let b = 200; b < this.maxCoarseBins; b++) {
                      if (this.coarseCorr[b] > bestVal) {
                        bestVal = this.coarseCorr[b];
                        bestBin = b;
                      }
                    }
                    if (bestVal > this.coarseEnergy * 0.35) {
                      this.coarseCenter = bestBin * 4;
                      this.coarseReady = true;
                      this.fineCorr.fill(0);
                      this.fineEnergy = 0;
                      this.fineSamples = 0;
                    } else {
                      this.coarseCorr.fill(0);
                      this.coarseEnergy = 0;
                      this.coarseSamples = 0;
                    }
                  }
                }
              }
              this.decimPos = (this.decimPos + 1) & this.decimMask;
            }

            // Stage 2: Refinamento exato de 1 sample ao redor de coarseCenter
            if (this.coarseReady) {
              const rCenter = this.refRing[(this.writePos - this.coarseCenter) & this.ringMask];
              if (rCenter * rCenter > 1e-6) {
                this.fineEnergy += rCenter * rCenter;
                this.fineSamples++;
                for (let f = 0; f < this.fineLen; f++) {
                  const candLag = this.coarseCenter + (f - this.fineRadius);
                  this.fineCorr[f] += d * this.refRing[(this.writePos - candLag) & this.ringMask];
                }
                if (this.fineSamples >= 3600) {
                  let bestF = this.fineRadius;
                  let bestVal = -1e9;
                  for (let f = 0; f < this.fineLen; f++) {
                    if (this.fineCorr[f] > bestVal) {
                      bestVal = this.fineCorr[f];
                      bestF = f;
                    }
                  }
                  const ratio = bestVal / (this.fineEnergy + 1e-12);
                  if (ratio > 0.45 && ratio < 1.55) {
                    const nextLag = this.coarseCenter + (bestF - this.fineRadius);
                    if (nextLag !== this.lockedLag) {
                      this.lockedLag = nextLag;
                      const initGain = Math.min(1.2, Math.max(0.8, ratio));
                      this.wL.fill(0); this.wL[4] = initGain;
                      this.wR.fill(0); this.wR[4] = initGain;
                    }
                    this.isLocked = true;
                  }
                  this.coarseReady = false;
                  this.coarseCorr.fill(0);
                  this.coarseEnergy = 0;
                  this.coarseSamples = 0;
                }
              }
            }

            // Stage 3: Subtração em tempo real APENAS da voz do amigo (100% do som do filme/jogo preservado!)
            if (this.isLocked) {
              const baseLag = this.lockedLag - 4;
              let yL = 0, yR = 0, norm = 1e-6;
              for (let k = 0; k < 9; k++) {
                const xk = this.refRing[(this.writePos - baseLag - k) & this.ringMask];
                yL += this.wL[k] * xk;
                yR += this.wR[k] * xk;
                norm += xk * xk;
              }
              const errL = dL - yL;
              const errR = dR - yR;
              if (norm > 1e-5) {
                const errP = (errL * errL + errR * errR) * 0.5;
                const mu = 0.012 / (norm + errP * 8.0 + 1e-4);
                for (let k = 0; k < 9; k++) {
                  const xk = this.refRing[(this.writePos - baseLag - k) & this.ringMask];
                  this.wL[k] += mu * errL * xk;
                  this.wR[k] += mu * errR * xk;
                }
              }
              outL[i] = errL;
              if (outR !== outL) outR[i] = errR;
            } else {
              outL[i] = dL;
              if (outR !== outL) outR[i] = dR;
            }

            this.writePos = (this.writePos + 1) & this.ringMask;
            this.sampleCount++;
          }
          return true;
        }
      }
      registerProcessor('voice-loopback-canceller', VoiceLoopbackCancellerProcessor);
    `

    const blob = new Blob([workletCode], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await ctx.audioWorklet.addModule(url)
      this.workletRegistered = true
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  async createWorkletCancelledAudioTrack(rawTrack: MediaStreamTrack): Promise<MediaStreamTrack | null> {
    try {
      const ctx = this.getAudioContext()
      await this.ensureLoopbackCancellerWorklet(ctx)

      const desktopSource = ctx.createMediaStreamSource(new MediaStream([rawTrack]))
      const cancellerNode = new AudioWorkletNode(ctx, 'voice-loopback-canceller', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })

      desktopSource.connect(cancellerNode, 0, 0)
      this.cancellerSources = [desktopSource]
      this.cancellerNode = cancellerNode

      // Referência = soma das vozes de todos os amigos na ligação
      for (const voiceStream of this.getRemoteVoiceStreams()) {
        if (voiceStream.getAudioTracks().length === 0) continue
        try {
          const voiceSource = ctx.createMediaStreamSource(voiceStream)
          voiceSource.connect(cancellerNode, 0, 1)
          this.cancellerSources.push(voiceSource)
        } catch (e) {
          console.warn('[WebRTC] Falha ao conectar voz de referência no cancelador:', e)
        }
      }

      const dest = ctx.createMediaStreamDestination()
      cancellerNode.connect(dest)
      console.log('[WebRTC] Trilha de áudio com cancelador adaptativo AudioWorklet ativada!')
      return dest.stream.getAudioTracks()[0] || null
    } catch (err) {
      console.warn('[WebRTC] Falha ao criar trilha cancelada por worklet:', err)
      return null
    }
  }

  async createExcludedLoopbackAudioTrack(options?: {
    mode?: 'include' | 'exclude'
    hwnd?: number
  }): Promise<MediaStreamTrack | null> {
    try {
      const started = await getMsnApi()?.startLoopbackCapture(options)
      if (!started) {
        console.warn('[WebRTC] Captura loopback nativa não iniciou (handshake/versão OS).')
        return null
      }

      const ctx = this.getAudioContext()
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {})
      }

      const dest = ctx.createMediaStreamDestination()

      // Jitter Buffer em Ring Buffer estéreo (1 segundo de capacidade = 48000 frames)
      const RING_FRAMES = 48000
      const ringL = new Float32Array(RING_FRAMES)
      const ringR = new Float32Array(RING_FRAMES)
      let writeIdx = 0
      let readIdx = 0
      let bufferedFrames = 0

      this.unsubLoopbackAudio = getMsnApi()!.onLoopbackAudioChunk((chunk: Uint8Array) => {
        // Garante alinhamento exato de 4 bytes (2 bytes x 2 canais PCM 16-bit)
        const validBytes = chunk.byteLength - (chunk.byteLength % 4)
        if (validBytes <= 0) return

        // Cópia alinhada para ArrayBuffer independente evitando RangeError de offset ímpar
        const safeBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + validBytes)
        const int16 = new Int16Array(safeBuffer)
        const frames = int16.length / 2

        for (let i = 0; i < frames; i++) {
          const sampleL = int16[i * 2] / 32768.0
          const sampleR = int16[i * 2 + 1] / 32768.0

          ringL[writeIdx] = sampleL
          ringR[writeIdx] = sampleR
          writeIdx = (writeIdx + 1) % RING_FRAMES
          if (bufferedFrames < RING_FRAMES) {
            bufferedFrames++
          } else {
            readIdx = (readIdx + 1) % RING_FRAMES
          }
        }

        // Mantém a latência do áudio baixa e ultra estável (~60ms de buffer alvo)
        if (bufferedFrames > 4800) {
          const skip = bufferedFrames - 2880
          readIdx = (readIdx + skip) % RING_FRAMES
          bufferedFrames -= skip
        }
      })

      // ScriptProcessor com buffer de 1024 frames (~21ms a 48kHz)
      const processor = ctx.createScriptProcessor(1024, 0, 2)
      let lastL = 0
      let lastR = 0

      processor.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0)
        const outR = e.outputBuffer.getChannelData(1)
        const len = outL.length

        for (let i = 0; i < len; i++) {
          if (bufferedFrames > 0) {
            outL[i] = ringL[readIdx]
            outR[i] = ringR[readIdx]
            lastL = outL[i]
            lastR = outR[i]
            readIdx = (readIdx + 1) % RING_FRAMES
            bufferedFrames--
          } else {
            // Suavização anti-estalo / anti-clipping com fade suave
            lastL *= 0.85
            lastR *= 0.85
            outL[i] = Math.abs(lastL) < 1e-4 ? 0 : lastL
            outR[i] = Math.abs(lastR) < 1e-4 ? 0 : lastR
          }
        }
      }

      // S4: Make-up gain compensatório de 1.35x com limitador contra atenuação pós-mixer do Windows
      const boostGain = ctx.createGain()
      boostGain.gain.value = 1.35

      // Limitador transparente de estúdio contra picos (-3dB threshold, ratio 4)
      const compressor = ctx.createDynamicsCompressor()
      compressor.threshold.value = -3
      compressor.knee.value = 4
      compressor.ratio.value = 4
      compressor.attack.value = 0.003
      compressor.release.value = 0.05

      processor.connect(boostGain)
      boostGain.connect(compressor)
      compressor.connect(dest)

      // Keep-alive com ganho zero para ctx.destination (impede que o Chromium pause ou faça GC do ScriptProcessor com 0 entradas)
      const dummyNode = ctx.createGain()
      dummyNode.gain.value = 0
      processor.connect(dummyNode)
      dummyNode.connect(ctx.destination)

      this.loopbackAudioProcessor = processor
      this.loopbackAudioDestNode = dest
      this.loopbackAudioGainNode = boostGain
      this.loopbackAudioCompressorNode = compressor
      this.loopbackAudioDummyNode = dummyNode

      console.log(`[WebRTC] Áudio de tela nativo (Modo ${options?.mode || 'exclude'}) inicializado com sucesso!`)
      return dest.stream.getAudioTracks()[0] || null
    } catch (err) {
      console.warn('[WebRTC] Falha ao iniciar loopback nativo:', err)
      return null
    }
  }

  cleanup(): void {
    if (this.unsubLoopbackAudio) {
      try {
        this.unsubLoopbackAudio()
      } catch {}
      this.unsubLoopbackAudio = null
    }
    getMsnApi()?.stopLoopbackCapture().catch(() => {})

    for (const node of [
      this.loopbackAudioProcessor,
      this.loopbackAudioGainNode,
      this.loopbackAudioCompressorNode,
      this.loopbackAudioDummyNode,
      this.cancellerNode,
      ...this.cancellerSources
    ]) {
      if (!node) continue
      try {
        node.disconnect()
      } catch {}
    }
    this.loopbackAudioProcessor = null
    this.loopbackAudioGainNode = null
    this.loopbackAudioCompressorNode = null
    this.loopbackAudioDummyNode = null
    this.loopbackAudioDestNode = null
    this.cancellerNode = null
    this.cancellerSources = []
  }
}
