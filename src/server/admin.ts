// Verwaltung auf der Kommandozeile (auf dem Server bzw. im Container):
//   node out/server/admin.js list
//   node out/server/admin.js reset-password <email> <neues-passwort>
//   node out/server/admin.js delete <email>
import { Accounts, validateCredentials } from './accounts'
import { config } from './config'
import { Users } from './users'

const [command, email, password] = process.argv.slice(2)
const accounts = await Accounts.open(config.dataDir)
const users = new Users(config.dataDir)

function find(address: string | undefined) {
  const user = address ? accounts.findByEmail(address) : undefined
  if (!user) {
    console.error(`Kein Konto für „${address ?? ''}“ gefunden.`)
    process.exit(1)
  }
  return user
}

switch (command) {
  case 'list':
    for (const user of accounts.all()) {
      const mb = (await users.usage(user.id)) / 1024 / 1024
      console.log(`${user.email.padEnd(40)} ${user.createdAt.slice(0, 10)}  ${mb.toFixed(1)} MB`)
    }
    break
  case 'reset-password': {
    const user = find(email)
    const problem = validateCredentials(user.email, password ?? '')
    if (problem) {
      console.error(problem)
      process.exit(1)
    }
    await accounts.changePassword(user.id, password!)
    console.log(`Passwort für ${user.email} geändert, alle Sitzungen beendet.`)
    break
  }
  case 'delete': {
    const user = find(email)
    await users.remove(user.id)
    await accounts.remove(user.id)
    console.log(`Konto ${user.email} samt Daten gelöscht.`)
    break
  }
  default:
    console.log('Befehle: list | reset-password <email> <passwort> | delete <email>')
}
