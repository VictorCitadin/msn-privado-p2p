import { Capacitor, registerPlugin } from '@capacitor/core'

/** Plugin nativo (android/.../ImmersivePlugin.java): tela cheia real e tela sempre acesa. */
interface ImmersivePlugin {
  enter(): Promise<void>
  exit(): Promise<void>
  keepAwake(options: { on: boolean }): Promise<void>
}

const Immersive = registerPlugin<ImmersivePlugin>('Immersive')
const isNative = Capacitor.isNativePlatform()

export async function enterImmersive(): Promise<void> {
  try {
    if (isNative) {
      await Immersive.enter()
    } else if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
    }
  } catch {
    // sem suporte: a interface ocupa a tela inteira do app mesmo assim
  }
}

export async function exitImmersive(): Promise<void> {
  try {
    if (isNative) {
      await Immersive.exit()
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
    }
  } catch {}
}

/** Mantém a tela acesa durante a ligação (com a tela apagada o Android pode derrubar a chamada). */
export async function setKeepAwake(on: boolean): Promise<void> {
  if (!isNative) return
  try {
    await Immersive.keepAwake({ on })
  } catch {}
}

/** O botão voltar do Android, com a tela cheia ativa, dispara este evento em vez de fechar o app. */
export const EXIT_FULLSCREEN_EVENT = 'vwExitFullscreen'
