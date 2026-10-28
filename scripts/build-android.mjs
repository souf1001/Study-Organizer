// Builds the signed Android release APK and copies it to release/Study-Organizer-<version>.apk.
// Needs a JDK (17+) and the Android SDK (ANDROID_HOME); on Windows the default install
// locations are detected automatically.
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const isWindows = process.platform === 'win32'
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function windowsDefaults(env) {
  if (!env.JAVA_HOME) {
    const jdk = ['jdk-23', 'jdk-21', 'jdk-17']
      .map((name) => join('C:\\Program Files\\Java', name))
      .find(existsSync)
    if (jdk) env.JAVA_HOME = jdk
  }
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT && env.LOCALAPPDATA) {
    const sdk = join(env.LOCALAPPDATA, 'Android', 'Sdk')
    if (existsSync(sdk)) env.ANDROID_HOME = sdk
  }
  return env
}

const env = isWindows ? windowsDefaults({ ...process.env }) : process.env

console.log('--- Building Android APK (assembleRelease) ---')
execSync(`${isWindows ? 'gradlew.bat' : './gradlew'} assembleRelease`, {
  cwd: join(root, 'android'),
  stdio: 'inherit',
  env,
})

const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!existsSync(apk)) throw new Error(`Expected APK not found: ${apk}`)

mkdirSync(join(root, 'release'), { recursive: true })
const target = join(root, 'release', `Study-Organizer-${version}.apk`)
copyFileSync(apk, target)
const megabytes = (statSync(target).size / 1024 / 1024).toFixed(1)
console.log(`\nDone: ${target} (${megabytes} MB)`)
