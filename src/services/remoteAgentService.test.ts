import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invokeRemoteAgent } from './remoteAgentService.js'

// Mock the integration config
vi.mock('../config/integrationConfig.js', () => ({
  integrationConfig: {
    remoteBackendUrl: 'http://localhost:3001',
    integrationMode: 'remote',
    useRemoteAgents: true,
  },
}))

// Mock global fetch
global.fetch = vi.fn()

describe('remoteAgentService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('invokeRemoteAgent', () => {
    it('should make POST request to backend /chat endpoint', async () => {
      const mockResponse = async function* () {
        yield JSON.stringify({ type: 'text', content: 'Hello from backend' })
      }

      ;(global.fetch as any).mockResolvedValueOnce({
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                'data: {"type":"text","content":"Hello"}\n\n'
              ),
            }),
          }),
        },
      })

      const result = invokeRemoteAgent('TestAgent', 'test message', ['tool1'], 'claude-opus-4-1')
      expect(result).toBeDefined()
    })

    it('should throw error if backend is unavailable', async () => {
      ;(global.fetch as any).mockRejectedValueOnce(
        new Error('Network error')
      )

      const result = invokeRemoteAgent('TestAgent', 'test message', ['tool1'], 'claude-opus-4-1')
      
      let errorThrown = false
      try {
        for await (const _ of result) {
          // consume
        }
      } catch (error) {
        errorThrown = true
      }

      expect(errorThrown).toBe(true)
    })

    it('should handle SSE stream correctly', async () => {
      const testData = [
        'data: {"type":"text","content":"chunk1"}\n\n',
        'data: {"type":"text","content":"chunk2"}\n\n',
      ].join('')

      ;(global.fetch as any).mockResolvedValueOnce({
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(testData),
              })
              .mockResolvedValueOnce({
                done: true,
                value: undefined,
              }),
          }),
        },
      })

      const result = invokeRemoteAgent('TestAgent', 'test', ['tool1'], 'claude-opus-4-1')
      
      const chunks: string[] = []
      for await (const chunk of result) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBeGreaterThan(0)
    })

    it('should send correct request body', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({
              done: true,
              value: undefined,
            }),
          }),
        },
      })

      const result = invokeRemoteAgent('TestAgent', 'test msg', ['tool1', 'tool2'], 'custom-model')
      
      for await (const _ of result) {
        // consume
      }

      expect((global.fetch as any)).toHaveBeenCalledWith(
        'http://localhost:3001/chat',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      )
    })
  })
})
