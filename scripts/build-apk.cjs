/**
 * Gera o APK do app do tablet (debug, instalável direto no Android).
 * Usa o JDK 21 que vem com o Android Studio (o Gradle do projeto não roda com Java 25).
 *
 * Uso: npm run android:apk
 * Saída: android/app/build/outputs/apk/debug/app-debug.apk (copiado para dist/)
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))

function findJavaHome() {
  const candidates = [
    process.env.ANDROID_STUDIO_JDK,
    'C:/Program Files/Android/Android Studio/jbr',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
    process.env.JAVA_HOME
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(path.join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')))
}

const javaHome = findJavaHome()
if (!javaHome) {
  console.error('JDK não encontrado. Instale o Android Studio ou defina ANDROID_STUDIO_JDK.')
  process.exit(1)
}

const env = { ...process.env, JAVA_HOME: javaHome }
const run = (cmd, cwd = root) => execSync(cmd, { cwd, env, stdio: 'inherit' })

run('npx vite build --config vite.mobile.config.ts')
run('npx cap sync android')
const androidDir = path.join(root, 'android')
// Caminho absoluto: o cmd pode estar configurado para não procurar executáveis na pasta atual
const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
run(`"${gradlew}" assembleDebug`, androidDir)

const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const outDir = path.join(root, 'dist')
fs.mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, `vitinho-e-will-tablet-${pkg.version}.apk`)
fs.copyFileSync(apk, target)
console.log(`\nAPK pronto: ${target}`)
