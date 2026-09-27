import Database from 'better-sqlite3'
import { normalizePhaseModels } from '../core/octa/models'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DATABASE_BUSY_TIMEOUT_MS } from './busy-timeout'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'

const SETTING_KEYS: readonly (keyof AppSettings)[] = [
  'geminiApiKey',
  'groqApiKey',
  'aiProvider',
  'vertexKeyPath',
  'vertexProjectId',
  'vertexLocation',
  'ntfyTopic',
  'ntfyServer',
  'octaHomePath',
  'updateRepository',
  'skillsLibraryPath',
  'vaultPath',
  'photoshopPath',
  'braveSearchApiKey',
  'theme',
  'locale',
  'geminiLiveModel',
  'geminiLiveModelOverride',
  'wakeWordEnabled',
  'wakeWordModelPath',
  'wakeWordSensitivity',
  'pushToTalkEnabled',
  'pushToTalkKey',
  'hotkey',
  'triggerType',
  'mouseButton',
  'wakeGreeting',
  'phaseModels'
]

const SETTING_KEY_SET = new Set<string>(SETTING_KEYS)

function stringSetting(value: unknown, maxLength: number, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : fallback
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function sensitivitySetting(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_SETTINGS.wakeWordSensitivity
}

function validNtfyServer(value: unknown): string {
  const candidate = stringSetting(value, 2_048, DEFAULT_SETTINGS.ntfyServer)
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_SETTINGS.ntfyServer
    return url.toString().replace(/\/+$/, '')
  } catch {
    return DEFAULT_SETTINGS.ntfyServer
  }
}

function readStored(database: Database.Database): Record<string, unknown> {
  const rows = database
    .prepare('SELECT key, value FROM app_settings')
    .all() as Array<{ key: string; value: string }>
  return Object.fromEntries(
    rows.map((row) => {
      try {
        return [row.key, JSON.parse(row.value) as unknown]
      } catch {
        return [row.key, row.value]
      }
    })
  )
}

export class SettingsRepository {
  private readonly database: Database.Database

  constructor(readonly databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath, { timeout: DATABASE_BUSY_TIMEOUT_MS })
    try {
      this.initialize()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  private initialize(): void {
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = FULL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    this.database
      .prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('firstRunCompleted', 'false')`)
      .run()
  }

  getSettings(): AppSettings {
    const stored = readStored(this.database)
    const legacyHotkey = stringSetting(stored.hotkey, 256, DEFAULT_SETTINGS.hotkey)
    const pushToTalkKey = stringSetting(
      stored.pushToTalkKey,
      256,
      stored.hotkey === undefined ? DEFAULT_SETTINGS.pushToTalkKey : legacyHotkey
    )
    const hotkey = stringSetting(
      stored.hotkey,
      256,
      pushToTalkKey
    )
    return {
      geminiApiKey: stringSetting(stored.geminiApiKey, 2_048),
      groqApiKey: stringSetting(stored.groqApiKey, 2_048),
      aiProvider: stored.aiProvider === 'vertex' ? 'vertex' : 'gemini',
      vertexKeyPath: stringSetting(stored.vertexKeyPath, 2_048),
      vertexProjectId: stringSetting(stored.vertexProjectId, 128),
      vertexLocation: stringSetting(stored.vertexLocation, 64) || 'global',
      ntfyTopic: stringSetting(stored.ntfyTopic, 256),
      ntfyServer: validNtfyServer(stored.ntfyServer),
      octaHomePath: stringSetting(stored.octaHomePath, 2_048, DEFAULT_SETTINGS.octaHomePath),
      updateRepository: stringSetting(stored.updateRepository, 256, DEFAULT_SETTINGS.updateRepository),
      skillsLibraryPath: stringSetting(stored.skillsLibraryPath, 2_048),
      vaultPath: stringSetting(stored.vaultPath, 2_048),
      photoshopPath: stringSetting(stored.photoshopPath, 2_048),
      braveSearchApiKey: stringSetting(stored.braveSearchApiKey, 2_048),
      theme: stored.theme === 'light' ? 'light' : 'dark',
      locale: stored.locale === 'en' ? 'en' : 'ar',
      geminiLiveModel: stringSetting(stored.geminiLiveModel, 256),
      geminiLiveModelOverride: stringSetting(stored.geminiLiveModelOverride, 256),
      wakeWordEnabled: booleanSetting(stored.wakeWordEnabled, DEFAULT_SETTINGS.wakeWordEnabled),
      wakeWordModelPath: stringSetting(stored.wakeWordModelPath, 2_048, DEFAULT_SETTINGS.wakeWordModelPath),
      wakeWordSensitivity: sensitivitySetting(stored.wakeWordSensitivity),
      pushToTalkEnabled: booleanSetting(stored.pushToTalkEnabled, DEFAULT_SETTINGS.pushToTalkEnabled),
      pushToTalkKey,
      hotkey,
      triggerType: stored.triggerType === 'mouse' ? 'mouse' : 'keyboard',
      mouseButton: stored.mouseButton === 3 || stored.mouseButton === 5 ? stored.mouseButton : 4,
      wakeGreeting: stringSetting(stored.wakeGreeting, 512, DEFAULT_SETTINGS.wakeGreeting),
      phaseModels: normalizePhaseModels(stored.phaseModels)
    }
  }

  setSettings(update: Partial<AppSettings>): AppSettings {
    const entries = Object.entries(update).filter(
      ([key, value]) => SETTING_KEY_SET.has(key) && value !== undefined
    )
    const transaction = this.database.transaction(() => {
      const statement = this.database.prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      for (const [key, value] of entries) statement.run(key, JSON.stringify(value))
    })
    transaction()
    return this.getSettings()
  }

  /**
   * Reads an internal JSON setting that is not part of the renderer settings
   * contract. Intake uses this for its resumable state.
   */
  getValue<T>(key: string): T | undefined {
    const row = this.database
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value?: string } | undefined
    if (!row?.value) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return row.value as T
    }
  }

  /** Stores an internal JSON setting without exposing it in AppSettings. */
  setValue(key: string, value: unknown): void {
    if (!key.trim() || key.length > 128) throw new Error('Invalid setting key.')
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, JSON.stringify(value))
  }

  deleteValue(key: string): void {
    this.database.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }

  /** Allows feature repositories to share this already-open SQLite connection. */
  getDatabase(): Database.Database {
    return this.database
  }

  checkpoint(): void {
    this.database.pragma('wal_checkpoint(TRUNCATE)')
  }

  close(): void {
    this.database.close()
  }
}
