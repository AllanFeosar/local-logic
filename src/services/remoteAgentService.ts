/**
 * Remote Agent Service
 * ─────────────────────────────────────────────────────────────────────────────
 * MIGRATION: Updated to use backendClient instead of hardcoded URL.
 *   - Uses BACKEND_URL from integrationConfig (no hardcoded localhost)
 *   - Streams responses via SSE
 *   - No provider SDK imports — all routing done by Backend
 */

import { BACKEND_URL } from '../config/integrationConfig.js'
import { backendClient, type ChatMessage } from './backendClient.js'

export interface RemoteAgentRequest {
  agentType: string
  userMessage: string
  tools: string[]
  model: string
  timestamp?: string
}

export interface RemoteAgentResponse {
  messageId: string
  content: string
  isDone: boolean
}

/**
 * Invoke a remote agent via Backend /chat endpoint.
 * Streams response chunks as they arrive.
 * No API keys or provider SDKs used here — all handled by Backend.
 */
export async function* invokeRemoteAgent(
  agentType: string,
  userMessage: string,
  tools: string[],
  model: string,
): AsyncGenerator<string> {
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }]
  const systemPrompt = `You are a helpful ${agentType} agent. Available tools: ${tools.join(', ')}.`

  yield* backendClient.streamChat(model, messages, systemPrompt)
}

/**
 * Invoke via raw fetch (legacy path — kept for backward compat).
 * New code should use invokeRemoteAgent above.
 */
export async function* invokeRemoteAgentRaw(
  agentType: string,
  userMessage: string,
  tools: string[],
  model: string,
): AsyncGenerator<string> {
  const response = await fetch(`${BACKEND_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentType, userMessage, tools, model, timestamp: new Date().toISOString() }),
  })

  if (!response.body) throw new Error('Response body is not readable')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value)
    }
  } finally {
    reader.releaseLock()
  }
}