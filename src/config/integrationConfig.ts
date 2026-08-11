/**
 * Integration Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * MIGRATION: Frontend now talks to Backend via HTTP only.
 *   - BACKEND_URL is the only provider connection config the Frontend needs
 *   - NO API keys in Frontend environment
 *   - NO provider SDKs imported here
 *
 * All model/provider logic lives in the Backend (mcp-openclaude/LlmBackend).
 * Frontend communicates exclusively via src/services/backendClient.ts
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../utils/debug.js'

/** URL of the Backend API — set BACKEND_URL in .env (no API keys here) */
export const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001'

/** URL of the C# Core agent runtime */
export const CSHARP_URL = process.env.CSHARP_URL ?? 'http://localhost:5000'

export interface IntegrationConfig {
  integrationMode: 'local' | 'remote'
  remoteBackendUrl?: string
  remoteBackendPort?: number
  useBuiltInAgents: boolean
  useRemoteAgents: boolean
  agents?: Record<string, 'local' | 'remote'>
}

const defaultConfig: IntegrationConfig = {
  integrationMode: 'remote',
  remoteBackendUrl: BACKEND_URL,
  useBuiltInAgents: true,
  useRemoteAgents: true,
}

export function loadIntegrationConfig(): IntegrationConfig {
  try {
    const configPath = join(homedir(), '.openclaude-integration.json')
    const configContent = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(configContent) as IntegrationConfig
    logForDebugging('[Integration] Config loaded from ' + configPath)
    config.remoteBackendUrl = BACKEND_URL  // always use env override
    return config
  } catch {
    logForDebugging('[Integration] Using default config — Backend at ' + BACKEND_URL)
    return defaultConfig
  }
}

export const integrationConfig = loadIntegrationConfig()