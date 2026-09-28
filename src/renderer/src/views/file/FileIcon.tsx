import { File, FileAudio, FileCode, FileImage, FileText, FileVideo, Presentation } from 'lucide-react'
import type { FileType } from '@shared/types'

export function FileIcon({ type, className }: { type: FileType | null; className?: string }) {
  switch (type) {
    case 'pdf':
      return <Presentation className={className} />
    case 'video':
      return <FileVideo className={className} />
    case 'audio':
      return <FileAudio className={className} />
    case 'image':
      return <FileImage className={className} />
    case 'text':
      return <FileCode className={className} />
    default:
      return <File className={className} />
  }
}

export function NoteIcon({ className }: { className?: string }) {
  return <FileText className={className} />
}

export const FILE_TYPE_LABELS: Record<FileType, string> = {
  pdf: 'PDF',
  video: 'Video',
  audio: 'Audio',
  image: 'Bild',
  text: 'Text',
  other: 'Datei',
}
