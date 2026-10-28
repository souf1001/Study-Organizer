// Periodic sync of calendar subscriptions and Moodle, shared by the desktop and Android apps.
import type { DataStore } from './data-store'
import type { Service } from './service'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const FIRST_SYNC_DELAY = 5_000
const DEFAULT_MOODLE_INTERVAL_MINUTES = 10

/**
 * Syncs everything shortly after start, then checks once a minute whether the intervals from
 * the settings are due. `onChange` runs after every sync. Returns a function that stops it.
 */
export function startBackgroundSync(
  service: Service,
  store: DataStore,
  onChange: () => void,
): () => void {
  let lastCalendarSync = Date.now()
  let lastMoodleSync = Date.now()

  const syncAll = async () => {
    await service.syncAll().catch(() => undefined)
    onChange()
  }

  const syncMoodle = async () => {
    if (!store.get().settings.moodle.url) return
    await service.moodleSync().catch(() => undefined)
    onChange()
  }

  const tick = () => {
    const { moodle, calendar } = store.get().settings
    const now = Date.now()
    const moodleMinutes = moodle.syncIntervalMinutes ?? DEFAULT_MOODLE_INTERVAL_MINUTES
    if (moodleMinutes > 0 && now - lastMoodleSync >= moodleMinutes * MINUTE) {
      lastMoodleSync = now
      void syncMoodle()
    }
    if (
      calendar.syncIntervalHours > 0 &&
      now - lastCalendarSync >= calendar.syncIntervalHours * HOUR
    ) {
      lastCalendarSync = now
      void syncAll()
    }
  }

  const firstSync = setTimeout(() => void syncAll(), FIRST_SYNC_DELAY)
  const interval = setInterval(tick, MINUTE)
  return () => {
    clearTimeout(firstSync)
    clearInterval(interval)
  }
}
