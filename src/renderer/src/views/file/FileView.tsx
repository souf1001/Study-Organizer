// Datei-Ansicht: wählt den passenden Betrachter (PDF, Video/Audio, Bild, Text, sonstige).
import { useEffect, useState, type WheelEvent } from 'react'
import { ExternalLink, Maximize2, Minus, Plus, RotateCw } from 'lucide-react'
import type { Item } from '@shared/types'
import { api, openFileLabel } from '@/lib/api'
import { formatSize } from '@/lib/format'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { toastError } from '@/ui/Toast'
import { FileIcon } from './FileIcon'
import { MediaPlayer } from './MediaPlayer'
import { PdfViewer } from './PdfViewer'
import './file.css'

function ImageViewer({ item }: { item: Item }) {
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [rotation, setRotation] = useState(0)
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    setZoom((z) => Math.min(8, Math.max(0.1, (z === 'fit' ? 1 : z) * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
  }
  return (
    <div className="file-view">
      <div className="file-toolbar">
        <IconButton label="Verkleinern" onClick={() => setZoom((z) => Math.max(0.1, (z === 'fit' ? 1 : z) / 1.25))}><Minus /></IconButton>
        <span className="small muted tabular zoom-label">{zoom === 'fit' ? 'Passend' : `${Math.round(zoom * 100)} %`}</span>
        <IconButton label="Vergrößern" onClick={() => setZoom((z) => Math.min(8, (z === 'fit' ? 1 : z) * 1.25))}><Plus /></IconButton>
        <IconButton label="Einpassen" pressed={zoom === 'fit'} onClick={() => setZoom('fit')}><Maximize2 /></IconButton>
        <IconButton label="Drehen" onClick={() => setRotation((r) => (r + 90) % 360)}><RotateCw /></IconButton>
        <span className="spacer" />
        <IconButton label={openFileLabel} onClick={() => void api.openFile(item).catch(toastError)}><ExternalLink /></IconButton>
      </div>
      <div className={`image-stage ${zoom === 'fit' ? 'fit' : ''}`} onWheel={onWheel}>
        <img
          src={api.fileUrl(item)}
          alt={item.title}
          draggable={false}
          style={{ transform: `rotate(${rotation}deg)`, width: zoom === 'fit' ? undefined : `${zoom * 100}%` }}
          onDoubleClick={() => setZoom((z) => (z === 'fit' ? 1 : 'fit'))}
        />
      </div>
    </div>
  )
}

function TextViewer({ item }: { item: Item }) {
  const [text, setText] = useState<string | null>(null)
  const url = api.fileUrl(item)
  useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => r.text())
      .then((t) => !cancelled && setText(t.slice(0, 2_000_000)))
      .catch((e) => !cancelled && toastError(e))
    return () => {
      cancelled = true
    }
  }, [url])
  return (
    <div className="file-view">
      <div className="file-toolbar">
        <span className="small muted">{formatSize(item.size)}</span>
        <span className="spacer" />
        <IconButton label={openFileLabel} onClick={() => void api.openFile(item).catch(toastError)}><ExternalLink /></IconButton>
      </div>
      <pre className="text-view selectable">{text}</pre>
    </div>
  )
}

function OtherFile({ item }: { item: Item }) {
  const office = /\.(pptx?|docx?|xlsx?|odp|odt|ods|key|pages)$/i.test(item.fileName ?? '')
  return (
    <Empty
      icon={<FileIcon type={item.fileType} />}
      title={item.title}
      action={
        <Button icon={<ExternalLink />} onClick={() => void api.openFile(item).catch(toastError)}>
          {openFileLabel}
        </Button>
      }
    >
      {formatSize(item.size)}
      {office && (
        <>
          <br />
          Tipp: Folien als PDF exportieren – dann lassen sie sich hier ansehen, markieren und von der KI zusammenfassen.
        </>
      )}
    </Empty>
  )
}

export function FileView({ item }: { item: Item }) {
  switch (item.fileType) {
    case 'pdf':
      return <PdfViewer item={item} />
    case 'video':
    case 'audio':
      return <MediaPlayer item={item} />
    case 'image':
      return <ImageViewer item={item} />
    case 'text':
      return <TextViewer item={item} />
    default:
      return <OtherFile item={item} />
  }
}
