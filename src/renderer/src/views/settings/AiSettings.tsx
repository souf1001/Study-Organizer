// KI-Einstellungen: Anbieter, API-Key (verschlüsselt), Modell, Test.
import { useEffect, useState } from 'react'
import { Check, Download, ExternalLink, Plug } from 'lucide-react'
import { AI_PROVIDERS, getProvider } from '@shared/ai-providers'
import { api, isWeb } from '@/lib/api'
import { updateSettings, useDb } from '@/lib/db'
import { Button } from '@/ui/Button'
import { Input, Select, Switch } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'
import { SettingGroup, SettingRow } from './SettingsView'

export function AiSettings() {
  const ai = useDb().settings.ai
  const provider = getProvider(ai.provider)
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setModels([])
    api.ai.hasKey(ai.provider).then(setHasKey).catch(() => setHasKey(false))
  }, [ai.provider])

  const saveKey = async () => {
    try {
      await api.ai.setKey(ai.provider, key)
      setHasKey(Boolean(key.trim()))
      setKey('')
      toast(key.trim() ? 'API-Key gespeichert' : 'API-Key entfernt')
    } catch (error) {
      toastError(error)
    }
  }

  const loadModels = async () => {
    try {
      const list = await api.ai.listModels()
      setModels(list)
      toast(`${list.length} Modelle gefunden`)
    } catch (error) {
      toastError(error)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const answer = await api.ai.stream({ system: 'Antworte in einem kurzen Satz.', messages: [{ role: 'user', content: 'Sag Hallo.' }], maxTokens: 200 }, () => undefined).done
      toast(`Verbindung klappt: „${answer.trim().slice(0, 80)}“`)
    } catch (error) {
      toastError(error)
    } finally {
      setTesting(false)
    }
  }

  const ready = hasKey || provider.keyOptional

  return (
    <>
      <SettingGroup title="KI-Funktionen">
        <SettingRow
          label="Aktivieren"
          description="Zusammenfassungen von Vorlesungen, Ordnern und Dateien sowie ein Chat mit deinen Unterlagen. Ohne Aktivierung wird nichts an einen KI-Dienst gesendet."
        >
          <Switch checked={ai.enabled} onChange={(enabled) => updateSettings('ai', { enabled })} label="KI aktivieren" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Anbieter">
        <SettingRow label="Dienst" description={provider.note}>
          <Select
            value={ai.provider}
            options={AI_PROVIDERS.filter((p) => !(isWeb && p.local)).map((p) => ({ value: p.id, label: p.free ? `${p.name} · kostenlos nutzbar` : p.name }))}
            onChange={(id) => updateSettings('ai', { provider: id, model: '', baseUrl: '' })}
          />
        </SettingRow>
        <SettingRow
          label={provider.keyOptional ? 'API-Key (optional)' : 'API-Key'}
          description={
            <>
              {hasKey ? (
                <span className="status-ok row">
                  <Check size={14} /> Gespeichert (verschlüsselt auf diesem Gerät)
                </span>
              ) : (
                'Noch kein Key hinterlegt.'
              )}
              {provider.keyUrl && (
                <>
                  {' '}
                  <a
                    href={provider.keyUrl}
                    onClick={(e) => {
                      e.preventDefault()
                      void api.openExternal(provider.keyUrl)
                    }}
                  >
                    Key erstellen <ExternalLink size={11} />
                  </a>
                </>
              )}
            </>
          }
        >
          <div className="row">
            <Input type="password" value={key} placeholder={hasKey ? '•••••••• ersetzen' : 'Key einfügen'} onChange={(e) => setKey(e.target.value)} />
            <Button onClick={() => void saveKey()} disabled={!key.trim() && !hasKey}>
              {key.trim() || !hasKey ? 'Speichern' : 'Entfernen'}
            </Button>
          </div>
        </SettingRow>
        {provider.customBaseUrl && (
          <SettingRow label="Basis-URL" description={provider.baseUrl ? `Standard: ${provider.baseUrl}` : 'Adresse der OpenAI-kompatiblen Schnittstelle, z. B. https://api.together.xyz/v1'}>
            <Input value={ai.baseUrl} placeholder={provider.baseUrl || 'https://…/v1'} onChange={(e) => updateSettings('ai', { baseUrl: e.target.value })} />
          </SettingRow>
        )}
        <SettingRow label="Modell" description={provider.defaultModel ? `Leer lassen für ${provider.defaultModel}` : 'Über „Modelle laden“ auswählen oder eintippen.'}>
          <div className="row">
            <Input list="ai-models" value={ai.model} placeholder={provider.defaultModel || 'Modellname'} onChange={(e) => updateSettings('ai', { model: e.target.value })} />
            <datalist id="ai-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Button icon={<Download />} disabled={!ready} onClick={() => void loadModels()}>
              Modelle laden
            </Button>
          </div>
        </SettingRow>
        <SettingRow label="Verbindung testen">
          <Button icon={<Plug />} disabled={!ai.enabled || !ready || testing} onClick={() => void test()}>
            {testing ? 'Teste …' : 'Testen'}
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Antworten">
        <SettingRow label="Sprache">
          <Select
            value={ai.language}
            options={[
              { value: 'de', label: 'Deutsch' },
              { value: 'en', label: 'Englisch' },
            ]}
            onChange={(language) => updateSettings('ai', { language })}
          />
        </SettingRow>
        <SettingRow label="Umfang der Unterlagen" description="Wie viel Text höchstens mitgeschickt wird. Größer = vollständiger, aber langsamer und teurer. Kleine Gratis-Modelle vertragen oft nur wenig.">
          <Select
            value={ai.maxContextChars}
            options={[
              { value: 20_000, label: 'Klein (ca. 5 Seiten)' },
              { value: 60_000, label: 'Mittel (ca. 15 Seiten)' },
              { value: 150_000, label: 'Groß (ca. 40 Seiten)' },
              { value: 400_000, label: 'Sehr groß (ca. 100 Seiten)' },
            ]}
            onChange={(maxContextChars) => updateSettings('ai', { maxContextChars })}
          />
        </SettingRow>
      </SettingGroup>

      <p className="small muted" style={{ marginTop: 16 }}>
        Datenschutz: Bei einer Zusammenfassung oder Chat-Frage werden die gewählten Notizen und Folientexte an den eingestellten Anbieter gesendet. Lokale Anbieter
        (Ollama, LM Studio) verlassen deinen Rechner nicht.
      </p>
    </>
  )
}
