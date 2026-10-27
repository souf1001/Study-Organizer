// Baut die Android-Release-APK und kopiert sie nach release/Study-Organizer-0.2.0.apk
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const env = { ...process.env }

if (isWin) {
  if (!env.JAVA_HOME) {
    if (existsSync('C:\\Program Files\\Java\\jdk-23')) {
      env.JAVA_HOME = 'C:\\Program Files\\Java\\jdk-23'
    } else if (existsSync('C:\\Program Files\\Java\\jdk-17')) {
      env.JAVA_HOME = 'C:\\Program Files\\Java\\jdk-17'
    }
  }
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
    const userProfile = env.USERPROFILE || 'C:\\Users\\Soufian'
    const sdkPath = join(userProfile, 'AppData', 'Local', 'Android', 'Sdk')
    if (existsSync(sdkPath)) {
      env.ANDROID_HOME = sdkPath
      env.ANDROID_SDK_ROOT = sdkPath
    }
  }
}

console.log('--- Baue Android APK (assembleRelease) ---')
const gradlew = isWin ? 'gradlew.bat' : './gradlew'
execSync(`${gradlew} assembleRelease`, {
  cwd: join(process.cwd(), 'android'),
  stdio: 'inherit',
  env,
})

const apkSrc = join(process.cwd(), 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!existsSync(apkSrc)) {
  throw new Error(`Erwartete APK unter ${apkSrc} wurde nicht gefunden!`)
}

const releaseDir = join(process.cwd(), 'release')
if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true })
}

const apkDest = join(releaseDir, 'Study-Organizer-0.2.0.apk')
copyFileSync(apkSrc, apkDest)

const stats = statSync(apkDest)
const mb = (stats.size / 1024 / 1024).toFixed(2)
console.log(`\n Erledigt: Android Release APK erfolgreich erstellt!`)
console.log(` Ziel: ${apkDest}`)
console.log(` Größe: ${mb} MB (${stats.size} Bytes)`)
