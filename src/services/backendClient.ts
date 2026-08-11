/**
 * Backend HTTP Client
 * ─────────────────────────────────────────────────────────────────────────────
 * MIGRATION: Replaces ALL direct provider SDK calls in the Frontend.
 *
 * Before migration: Frontend imported @anthropic-ai/sdk, openai, etc. and
 *   called providers directly with API keys from environment.
 *
 * After migration: Frontend calls Backend HTTP API ONLY.
 *   - No API keys in Frontend
 *   - No provider SDKs in Frontend
 *   - All model logic lives in Backend
 *
 * Usage:
 *   import { backendClient } from './backendClient.js'
 *
 *   const models = await backendClient.getModels()
 *   const model  = await backendClient.selectModel('coding')
 *   for await (const chunk of backendClient.streamChat(modelId, messages)) { ... }
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001'
const DEFAULT_TIMEOUT_MS = 30_000
const STREAM_TIMEOUT_MS  = 120_000

// ── Types ─────────────────────────────────────────────────────────────────

export interface BackendModel {
  id: string
  name: string
  provider: string
  contextWindow: number
  costTier: 'free' | 'low' | 'mid' | 'premium'
  strengths: string[]
  inputCostPer1M: number
  outputCostPer1M: number
  available: boolean
}

export interface ProviderStatus {
  providers: Record<string, {
    available: boolean
    name: string
    keyHint?: string | null
    baseUrl?: string
    region?: string
    projectId?: string
    resource?: string
  }>
  defaultProvider: string | null
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | unknown[]
  tool_use_id?: string
}

export interface HealthStatus {
  status: string
  uptime: number
  configuredProviders: number
  csharpAvailable: boolean
  timestamp: string
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Backend ${res.status}: ${body || res.statusText}`)
    }
    return res
  } finally {
    clearTimeout(timer)
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export const backendClient = {
  /** Base URL — can be overridden for testing */
  baseUrl: BACKEND_URL,

  // ── 1. Model discovery ─────────────────────────────────────────────────

  /** Get all models with runtime availability flags. */
  async getModels(): Promise<BackendModel[]> {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/models`)
    const data = await res.json() as { models: BackendModel[] }
    return data.models
  },

  // ── 2. Model selection ─────────────────────────────────────────────────

  /**
   * Select best model for a capability.
   * @param capability 'coding' | 'reasoning' | 'fast' | 'local' | 'balanced' | 'low-cost'
   */
  async selectModel(capability: string, preferredModel?: string): Promise<BackendModel> {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/select-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability, preferredModel }),
    })
    return res.json() as Promise<BackendModel>
  },

  // ── 3. Credential / provider status ────────────────────────────────────

  /** Get which providers are configured — NO actual keys returned. */
  async getCredentialStatus(): Promise<ProviderStatus> {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/credential-status`)
    return res.json() as Promise<ProviderStatus>
  },

  /** Alias for credential status */
  async getProviderStatus(): Promise<ProviderStatus> {
    return this.getCredentialStatus()
  },

  // ── 4. Chat (streaming) ────────────────────────────────────────────────

  /**
   * Stream a chat response from the Backend.
   * Replaces: new Anthropic({ apiKey }).messages.create(...)
   *           new OpenAI({ apiKey }).chat.completions.create(...)
   *
   * Yields text chunks as they arrive (SSE stream).
   */
  async *streamChat(
    modelId: string,
    messages: ChatMessage[],
    systemPrompt?: string,
  ): AsyncGenerator<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, messages, systemPrompt, stream: true }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        throw new Error(`Backend chat failed: ${res.status} ${res.statusText}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          try {
            const parsed = JSON.parse(raw) as { text?: string; done?: boolean; error?: string }
            if (parsed.error) throw new Error(`Provider error: ${parsed.error}`)
            if (parsed.done) return
            if (parsed.text) yield parsed.text
          } catch (e) {
            if (e instanceof SyntaxError) continue // partial chunk
            throw e
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  },

  /**
   * Non-streaming chat — waits for full response.
   */
  async chat(
    modelId: string,
    messages: ChatMessage[],
    systemPrompt?: string,
  ): Promise<{ content: Array<{ type: string; text?: string }>; usage?: unknown }> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, messages, systemPrompt, stream: false }),
      },
      STREAM_TIMEOUT_MS,
    )
    return res.json()
  },

  // ── 5. Orchestration ───────────────────────────────────────────────────

  /**
   * Run multi-agent orchestration via Backend → C# Core.
   * Replaces any direct C# calls from Frontend.
   */
  async *orchestrate(
    orchestratorModel: string,
    agents: Array<{ name: string; model: string }>,
    task: string,
  ): AsyncGenerator<{ agent?: string; message?: string; done?: boolean }> {
    const res = await fetch(`${this.baseUrl}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orchestratorModel, agents, task }),
    })

    if (!res.ok || !res.body) {
      throw new Error(`Orchestration failed: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          yield JSON.parse(line)
        } catch { /* skip partial */ }
      }
    }
  },

  // ── 6. Health check ────────────────────────────────────────────────────

  /** Check if Backend is running. Returns null on failure (no throw). */
  async health(): Promise<HealthStatus | null> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/api/health`, {}, 5_000)
      return res.json() as Promise<HealthStatus>
    } catch {
      return null
    }
  },

  /** Returns true if Backend is reachable. */
  async isAvailable(): Promise<boolean> {
    const h = await this.health()
    return h?.status === 'healthy'
  },

  // ── 7. Model info ──────────────────────────────────────────────────────

  async getModel(modelId: string): Promise<BackendModel | null> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/api/model/${encodeURIComponent(modelId)}`)
      return res.json() as Promise<BackendModel>
    } catch {
      return null
    }
  },

  // ── 8. Capabilities ────────────────────────────────────────────────────

  async getCapabilities(): Promise<string[]> {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/capabilities`)
    const data = await res.json() as { capabilities: string[] }
    return data.capabilities
  },
}

export default backendClient
