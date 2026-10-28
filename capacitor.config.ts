// Capacitor wraps the built renderer (out/renderer) into the Android app.
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'de.studyorganizer.app',
  appName: 'Study Organizer',
  webDir: 'out/renderer',
  server: {
    // Serve the app from https://localhost so web APIs that need a secure context work
    androidScheme: 'https',
  },
  plugins: {
    // Routes fetch() through Android's native HTTP stack: Moodle, calendar feeds and AI
    // providers do not send CORS headers, so plain browser requests would be blocked.
    CapacitorHttp: { enabled: true },
  },
}

export default config
