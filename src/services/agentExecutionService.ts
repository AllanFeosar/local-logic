import { logForDebugging } from '../utils/debug.js'
import { invokeRemoteAgent } from './remoteAgentService.js'
import { integrationConfig } from '../config/integrationConfig.js'

export interface AgentExecutionRequest {
  agentType: string
  userMessage: string
  tools: string[]
  model: string
  context?: Record<string, unknown>
}

/**
 * Execute agent with integration support
 * Routes to remote backend if configured, otherwise uses built-in agent
 */
export async function* executeAgent(
  request: AgentExecutionRequest,
): AsyncGenerator<string> {
  const { agentType, userMessage, tools, model } = request

  logForDebugging(
    `[Agent] Executing: ${agentType} (mode: ${integrationConfig.integrationMode})`,
  )

  // Check if this agent should use remote execution
  const agentMode = integrationConfig.agents?.[agentType]
  const shouldUseRemote =
    integrationConfig.integrationMode === 'remote' &&
    (agentMode === 'remote' || integrationConfig.useRemoteAgents)

  if (shouldUseRemote && integrationConfig.remoteBackendUrl) {
    logForDebugging(
      `[Agent] Routing to remote backend: ${integrationConfig.remoteBackendUrl}`,
    )

    try {
      yield* invokeRemoteAgent(agentType, userMessage, tools, model)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`[Agent] Remote execution failed: ${errorMessage}`)

      // Fallback to local/built-in if remote fails
      if (integrationConfig.useBuiltInAgents) {
        logForDebugging(`[Agent] Falling back to built-in agent`)
        yield `[Agent] Remote connection failed, using built-in agent...\n`
        yield `Error: ${errorMessage}\n`
      } else {
        throw error
      }
    }
  } else if (integrationConfig.useBuiltInAgents) {
    logForDebugging(`[Agent] Using built-in agent: ${agentType}`)
    // Local/built-in agent execution would go here
    yield `[Agent] Built-in agent mode: ${agentType}\n`
  } else {
    throw new Error(
      `No execution mode available for agent: ${agentType}. Check ~/.openclaude-integration.json`,
    )
  }
}

/**
 * Check if agent execution is properly configured
 */
export function validateAgentConfiguration(): string[] {
  const errors: string[] = []

  if (!integrationConfig.integrationMode) {
    errors.push('integrationMode not set in ~/.openclaude-integration.json')
  }

  if (
    integrationConfig.integrationMode === 'remote' &&
    !integrationConfig.remoteBackendUrl
  ) {
    errors.push(
      'Remote mode selected but remoteBackendUrl not configured. Set it in ~/.openclaude-integration.json',
    )
  }

  if (
    !integrationConfig.useBuiltInAgents &&
    !integrationConfig.useRemoteAgents
  ) {
    errors.push(
      'No agent execution mode enabled. Enable either useBuiltInAgents or useRemoteAgents in ~/.openclaude-integration.json',
    )
  }

  return errors
}
