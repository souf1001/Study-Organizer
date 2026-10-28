// The readable documents folder on Android: Documents/Study Organizer in the shared storage,
// visible in the Files app and to other apps. The app's data stays in IndexedDB; this folder
// holds a copy of every document in the semester / module / folder structure.
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { LayoutFs } from '@backend/documents-layout'
import type { KeyValueStore } from '@backend/key-value'

const ROOT = 'Study Organizer'
export const DOCUMENTS_LABEL = `Interner Speicher › Documents › ${ROOT}`
// Large files are copied in pieces so they never have to fit into memory as one string
const CHUNK_BYTES = 3 * 1024 * 1024

const at = (rel: string) => ({
  path: rel ? `${ROOT}/${rel}` : ROOT,
  directory: Directory.Documents,
})

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Asks for storage access where Android needs it (Android 10 and older) */
export async function documentsFolderAllowed(): Promise<boolean> {
  try {
    const { publicStorage } = await Filesystem.checkPermissions()
    if (publicStorage === 'granted') return true
    return (await Filesystem.requestPermissions()).publicStorage === 'granted'
  } catch {
    return false
  }
}

export function androidDocumentsFs(storage: KeyValueStore): LayoutFs {
  const exists = (rel: string) =>
    Filesystem.stat(at(rel)).then(
      () => true,
      () => false,
    )
  return {
    exists,
    mkdir: async (rel) => {
      if (await exists(rel)) return
      await Filesystem.mkdir({ ...at(rel), recursive: true })
    },
    move: async (from, to) => {
      await Filesystem.rename({
        from: at(from).path,
        to: at(to).path,
        directory: Directory.Documents,
        toDirectory: Directory.Documents,
      })
    },
    remove: async (rel) => {
      if (await exists(rel)) await Filesystem.deleteFile(at(rel))
    },
    removeDirIfEmpty: async (rel) => {
      try {
        const { files } = await Filesystem.readdir(at(rel))
        if (files.length === 0) await Filesystem.rmdir(at(rel))
      } catch {
        // Already gone
      }
    },
    createFile: async (item, rel) => {
      const blob = item.fileName ? await storage.get<Blob>('files', item.fileName) : null
      if (!blob) return false
      await Filesystem.writeFile({
        ...at(rel),
        data: await blobToBase64(blob.slice(0, CHUNK_BYTES)),
        recursive: true,
      })
      for (let start = CHUNK_BYTES; start < blob.size; start += CHUNK_BYTES) {
        await Filesystem.appendFile({
          ...at(rel),
          data: await blobToBase64(blob.slice(start, start + CHUNK_BYTES)),
        })
      }
      return true
    },
    writeText: async (rel, text) => {
      await Filesystem.writeFile({
        ...at(rel),
        data: text,
        encoding: Encoding.UTF8,
        recursive: true,
      })
    },
  }
}
