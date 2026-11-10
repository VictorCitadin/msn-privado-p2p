import type { CapacitorConfig } from '@capacitor/cli'

/**
 * App do tablet (Android): chat em grupo + ligação, usando o mesmo motor WebRTC do app de PC.
 * Build: npm run android:apk  →  android/app/build/outputs/apk/debug/app-debug.apk
 */
const config: CapacitorConfig = {
  appId: 'com.vitinhowill.msnprivado.tablet',
  appName: 'Vitinho e Will',
  webDir: 'mobile-dist',
  android: {
    // Evita que o WebView pause timers/áudio ao perder o foco por um instante
    webContentsDebuggingEnabled: false
  }
}

export default config
