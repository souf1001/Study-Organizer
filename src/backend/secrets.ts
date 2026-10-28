/** Storage for secret values (API keys, Moodle token, private calendar addresses), kept apart from the database */
export interface Secrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
}
