import { invokeRemoteAgent } from '../../services/remoteAgentService.js'
import { integrationConfig } from '../../config/integrationConfig.js'
import { logForDebugging } from '../../utils/debug.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import type { AssistantMessage } from '../../types/message.js'
import { randomUUID } from 'crypto'

/**
 * Check if agent should execute remotely
 */
export function shouldExecuteRemote(agentDefinition: AgentDefinition): boolean {
  const agentRoutingConfig = integrationConfig.agents?.[agentDefinition.agentType]
  const useRemote =
    integrationConfig.integrationMode === 'remote' ||
    agentRoutingConfig === 'remote'
  return useRemote && integrationConfig.useRemoteAgents
}

/**
 * Execute agent remotely and stream responses as assistant messages
 * Returns messages as they stream from the backend
 */
export async function* executeAgentRemote(
  agentDefinition: AgentDefinition,
  userMessage: string,
): AsyncGenerator<AssistantMessage, void> {
  logForDebugging(
    `[Agent] Routing ${agentDefinition.agentType} to remote backend`,
  )

  try {
    const remoteStream = invokeRemoteAgent(
      agentDefinition.agentType,
      userMessage,
      agentDefinition.tools || [],
      agentDefinition.model || 'claude-opus-4-1',
    )

    let fullContent = ''
    const messageId = randomUUID()

    // Stream chunks from remote backend and yield as assistant message
    for await (const chunk of remoteStream) {
      fullContent += chunk

      yield {
        type: 'assistant' as const,
        content: fullContent,
        id: messageId,
      }
    }

    logForDebugging(
      `[Agent] Remote execution completed: ${agentDefinition.agentType}`,
    )
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error)
    logForDebugging(
      `[Agent] Remote execution failed: ${errorMessage}`,
      { level: 'warn' },
    )

    // Yield error message to user
    yield {
      type: 'assistant' as const,
      content: `[Agent Error] Failed to execute remote agent: ${errorMessage}\n\nFalling back to local execution...`,
      id: randomUUID(),
    }
  }
}