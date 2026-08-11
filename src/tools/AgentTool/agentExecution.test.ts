import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shouldExecuteRemote, executeAgentRemote } from './agentExecution.js'
import * as remoteAgentService from '../../services/remoteAgentService.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Mock the integration config
vi.mock('../../config/integrationConfig.js', () => ({
  integrationConfig: {
    integrationMode: 'remote',
    useRemoteAgents: true,
    agents: {},
  },
}))

// Mock debug logging
vi.mock('../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

describe('agentExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('shouldExecuteRemote', () => {
    it('should return true when remote mode is enabled', () => {
      const agent: AgentDefinition = {
        agentType: 'TestAgent',
        tools: [],
        prompt: 'test',
      } as AgentDefinition

      const result = shouldExecuteRemote(agent)
      expect(result).toBe(true)
    })
  })

  describe('executeAgentRemote', () => {
    it('should stream remote agent responses', async () => {
      const mockStream = async function* () {
        yield 'Hello '
        yield 'from '
        yield 'remote agent'
      }

      vi.spyOn(remoteAgentService, 'invokeRemoteAgent').mockImplementation(
        () => mockStream() as any
      )

      const agent: AgentDefinition = {
        agentType: 'TestAgent',
        tools: [],
        prompt: 'test',
        model: 'claude-opus-4-1',
      } as AgentDefinition

      const messages: string[] = []
      for await (const msg of executeAgentRemote(agent, 'test input')) {
        if (msg.type === 'assistant') {
          messages.push(msg.content)
        }
      }

      expect(messages.length).toBeGreaterThan(0)
      expect(messages[messages.length - 1]).toContain('Hello from remote agent')
    })

    it('should handle remote execution errors gracefully', async () => {
      vi.spyOn(remoteAgentService, 'invokeRemoteAgent').mockImplementation(() => {
        throw new Error('Backend unavailable')
      })

      const agent: AgentDefinition = {
        agentType: 'TestAgent',
        tools: [],
        prompt: 'test',
      } as AgentDefinition

      const messages: string[] = []
      for await (const msg of executeAgentRemote(agent, 'test input')) {
        if (msg.type === 'assistant') {
          messages.push(msg.content)
        }
      }

      expect(messages.length).toBeGreaterThan(0)
      expect(messages[0]).toContain('Failed to execute remote agent')
    })

    it('should use agent model when available', async () => {
      const mockStream = async function* () {
        yield 'test'
      }

      const invokeRemoteAgentSpy = vi
        .spyOn(remoteAgentService, 'invokeRemoteAgent')
        .mockImplementation(() => mockStream() as any)

      const agent: AgentDefinition = {
        agentType: 'TestAgent',
        tools: ['tool1', 'tool2'],
        prompt: 'test',
        model: 'custom-model',
      } as AgentDefinition

      const messages: string[] = []
      for await (const msg of executeAgentRemote(agent, 'test input')) {
        // consume generator
      }

      expect(invokeRemoteAgentSpy).toHaveBeenCalledWith(
        'TestAgent',
        'test input',
        ['tool1', 'tool2'],
        'custom-model'
      )
    })
  })
})
