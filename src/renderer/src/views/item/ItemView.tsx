// Einzelner Eintrag: Notiz oder Datei.
import type { Item } from '@shared/types'
import { FileView } from '../file/FileView'
import { NoteView } from '../note/NoteView'

export default function ItemView({ item }: { item: Item }) {
  return item.kind === 'note' ? <NoteView item={item} /> : <FileView item={item} />
}
