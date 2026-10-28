// Hands a file to Android: written to the app cache, then offered through the system share
// sheet, where the user can save it (Files, Drive …) or open it with another app.
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

type Content = { text: string } | { base64: string }

/** Returns false if the user closed the share sheet without choosing a target */
export async function shareFile(
  fileName: string,
  content: Content,
  title: string,
): Promise<boolean> {
  const { uri } = await Filesystem.writeFile({
    path: fileName,
    directory: Directory.Cache,
    ...('text' in content
      ? { data: content.text, encoding: Encoding.UTF8 }
      : { data: content.base64 }),
  })
  try {
    await Share.share({ title, dialogTitle: title, files: [uri] })
    return true
  } catch (error) {
    if (/cancel/i.test((error as Error).message)) return false
    throw error
  }
}
