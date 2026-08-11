import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth.js'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    client_data: z.record(z.unknown()).nullish(),
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped: Nonessential traffic disabled')
    return null
  }

  if (getAPIProvider() !== 'firstParty') {
    logForDebugging('[Bootstrap] Skipped: 3P provider')
    return null
  }

  // OAuth preferred (requires user:profile scope — service-key OAuth tokens
  // lack it and would 403). Fall back to API key auth for console users.
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getClaudeAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] Skipped: no usable OAuth or API key')
    return null
  }

  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`

  // withOAuth401Retry handles the refresh-and-retry. API key users fail
  // through on 401 (no refresh mechanism — no OAuth token to pass).
  try {
    return await withOAuth401Retry(async () => {
      // Re-read OAuth each call so the retry picks up the refreshed token.
      const token = getClaudeAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      } else if (apiKey) {
        authHeaders = { 'x-api-key': apiKey }
      } else {
        logForDebugging('[Bootstrap] No auth available on retry, aborting')
        return null
      }

      logForDebugging('[Bootstrap] Fetching')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getClaudeCodeUserAgent(),
          ...authHeaders,
        },
        timeout: 5000,
      })
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] Response failed validation: ${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] Fetch ok')
      return parsed.data
    })
  } catch (error) {
    logForDebugging(
      `[Bootstrap] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    throw error
  }
}

/**
 * Fetch available models from the backend and format them as ModelOptions.
 * Called regardless of provider — the backend always knows which models are live.
 * Returns [] if the backend is not running (non-fatal).
 */
async function fetchBackendModelOptions(): Promise<
  { value: string; label: string; description: string }[]
> {
  try {
    const { backendClient } = await import('../backendClient.js')
    const models = await Promise.race([
      backendClient.getModels(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000),
      ),
    ])
    return models
      .filter(m => m.available)
      // Exclude Anthropic/Bedrock — ModelPicker already shows those via getModelOptionsBase()
      .filter(m => m.provider !== 'anthropic' && m.provider !== 'bedrock')
      .map(m => ({
        value: m.id,
        label: m.name,
        description: `${m.provider.toUpperCase()} · ${m.costTier === 'free' ? 'Free' : `$${m.inputCostPer1M ?? '?'}/1M`} · via backend`,
      }))
  } catch {
    logForDebugging('[Bootstrap] Backend model fetch skipped (not running or timeout)')
    return []
  }
}

/**
 * Fetch bootstrap data from the API and persist to disk cache.
 * Also fetches available models from the backend so the model picker
 * shows all providers (NVIDIA, Bytez, Ollama, OpenRouter, etc.)
 * without requiring an Anthropic API key.
 */
export async function fetchBootstrapData(): Promise<void> {
  try {
    // Fetch Anthropic bootstrap (first-party only) and backend models in parallel
    const [response, backendModelOptions] = await Promise.all([
      fetchBootstrapAPI(),
      fetchBackendModelOptions(),
    ])

    const clientData = response?.client_data ?? null
    // Merge Anthropic additional options (if any) with live backend models
    const anthropicOptions = response?.additional_model_options ?? []
    const merged = [...anthropicOptions]
    for (const opt of backendModelOptions) {
      if (!merged.some(existing => existing.value === opt.value)) {
        merged.push(opt)
      }
    }
    const additionalModelOptions = merged

    if (additionalModelOptions.length > 0) {
      logForDebugging(
        `[Bootstrap] ${anthropicOptions.length} Anthropic + ${backendModelOptions.length} backend model options (${additionalModelOptions.length} total)`,
      )
    }

    // Only persist if data actually changed — avoids a config write on every startup.
    const config = getGlobalConfig()
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions)
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: additionalModelOptions,
    }))
  } catch (error) {
    logError(error)
  }
}
