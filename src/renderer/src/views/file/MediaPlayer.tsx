// Video- und Audio-Player mit einstellbarer Geschwindigkeit, Sprüngen und gemerkter Position.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Maximize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react'
import type { Item } from '@shared/types'
import { api } from '@/lib/api'
import { IconButton } from '@/ui/Button'
import { showMenu } from '@/ui/Menu'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

// Position und Geschwindigkeit pro Datei merken (nur auf diesem Gerät)
const storageKey = (id: string) => `media:${id}`
function loadState(id: string): { time: number; rate: number } {
  try {
    return { time: 0, rate: 1, ...JSON.parse(localStorage.getItem(storageKey(id)) ?? '{}') }
  } catch {
    return { time: 0, rate: 1 }
  }
}
function saveState(id: string, time: number, rate: number): void {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify({ time, rate }))
  } catch {
    // Speicher voll oder gesperrt – nicht schlimm
  }
}

export function MediaPlayer({ item }: { item: Item }) {
  const ref = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const isVideo = item.fileType === 'video'

  useEffect(() => {
    const media = ref.current
    if (!media) return
    const saved = loadState(item.id)
    const onLoaded = () => {
      setDuration(media.duration)
      if (saved.time > 5 && saved.time < media.duration - 5) media.currentTime = saved.time
      media.playbackRate = saved.rate
      setRate(saved.rate)
    }
    media.addEventListener('loadedmetadata', onLoaded)
    const interval = setInterval(() => !media.paused && saveState(item.id, media.currentTime, media.playbackRate), 5000)
    return () => {
      media.removeEventListener('loadedmetadata', onLoaded)
      clearInterval(interval)
      saveState(item.id, media.currentTime, media.playbackRate)
    }
  }, [item.id])

  const media = () => ref.current!
  const toggle = () => (media().paused ? void media().play() : media().pause())
  const skip = (seconds: number) => {
    media().currentTime = Math.min(Math.max(0, media().currentTime + seconds), duration || Infinity)
  }
  const changeRate = (value: number) => {
    media().playbackRate = value
    setRate(value)
    saveState(item.id, media().currentTime, value)
  }
  const stepRate = (direction: 1 | -1) => {
    const index = SPEEDS.indexOf(rate)
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (index === -1 ? 2 : index) + direction))]
    changeRate(next)
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const actions: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      j: () => skip(-10),
      l: () => skip(10),
      ArrowLeft: () => skip(-5),
      ArrowRight: () => skip(5),
      '<': () => stepRate(-1),
      '>': () => stepRate(1),
      m: () => {
        media().muted = !media().muted
      },
      f: () => void wrapRef.current?.requestFullscreen(),
    }
    const action = actions[e.key]
    if (action) {
      e.preventDefault()
      action()
    }
  }

  return (
    <div className="media-player" ref={wrapRef} tabIndex={0} onKeyDown={onKey}>
      <div className={`media-stage ${isVideo ? '' : 'audio'}`} onClick={toggle}>
        <video
          ref={ref}
          src={api.fileUrl(item)}
          preload="metadata"
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onVolumeChange={(e) => {
            setMuted(e.currentTarget.muted)
            setVolume(e.currentTarget.volume)
          }}
        />
        {!isVideo && <div className="audio-title">{item.title}</div>}
      </div>
      <div className="media-controls">
        <input
          className="seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          aria-label="Position"
          onChange={(e) => {
            media().currentTime = Number(e.target.value)
          }}
          style={{ '--progress': `${duration ? (time / duration) * 100 : 0}%` } as React.CSSProperties}
        />
        <div className="media-row">
          <IconButton label="10 Sekunden zurück (J)" onClick={() => skip(-10)}><RotateCcw /></IconButton>
          <IconButton label={playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={toggle}>
            {playing ? <Pause /> : <Play />}
          </IconButton>
          <IconButton label="10 Sekunden vor (L)" onClick={() => skip(10)}><RotateCw /></IconButton>
          <span className="small muted tabular media-time">
            {formatClock(time)} / {formatClock(duration)}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost tabular"
            title="Geschwindigkeit (< >)"
            onClick={(e) =>
              showMenu(e.currentTarget, [
                { heading: 'Geschwindigkeit' },
                ...SPEEDS.map((s) => ({ label: `${s.toLocaleString('de-DE')}×`, onClick: () => changeRate(s) })),
              ])
            }
          >
            {rate.toLocaleString('de-DE')}×
          </button>
          <IconButton
            label={muted ? 'Ton an (M)' : 'Stumm (M)'}
            onClick={() => {
              media().muted = !muted
            }}
          >
            {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
          </IconButton>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Lautstärke"
            onChange={(e) => {
              media().volume = Number(e.target.value)
              media().muted = false
            }}
          />
          {isVideo && (
            <>
              <IconButton label="Bild-in-Bild" onClick={() => void media().requestPictureInPicture().catch(() => undefined)}>
                <PictureInPicture2 />
              </IconButton>
              <IconButton label="Vollbild (F)" onClick={() => void wrapRef.current?.requestFullscreen()}>
                <Maximize />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
