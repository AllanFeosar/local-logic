import type { Command } from '../../commands.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AGENTS COMMAND HANDLER - Frontend Layer
 *
 * Purpose: Manage AI agent configurations and execution from CLI
 *
 * Frontend Integration Layer:
 * User commands available:
 *   > agents list              - List all agents (GETs from Backend /agents)
 *   > agents create            - Create new agent (POSTs to Backend /agents/create)
 *   > agents info <id>         - View agent details (GETs from Backend /agents/<id>)
 *   > agents delete <id>       - Remove agent (DELETEs via Backend /agents/<id>)
 *   > agents assign-tools      - Control tool access (PUTs to Backend /agents/<id>/tools)
 *
 * How it works:
 * ─────────────
 * 1. User types "agents list" in CLI
 * 2. Frontend (this command) displays interactive menu
 * 3. User selections trigger API calls to Backend (port 3001)
 * 4. Backend routes requests to C# Core (port 5000)
 * 5. C# IMultiAgentOrchestrator processes agent operations
 * 6. Results stream back to Frontend
 * 7. CLI displays formatted agent information
 *
 * Architecture Flow:
 * ─────────────────
 * CLI Input
 *   │
 *   ├─ OpenClaude Frontend (this file)
 *   │   └─ Converts user input to structured requests
 *   │
 *   ├─ HTTP POST/GET to Backend
 *   │   └─ http://localhost:3001/agents/*
 *   │
 *   ├─ Backend Routes to C#
 *   │   └─ http://localhost:5000/api/agents/*
 *   │
 *   ├─ C# IMultiAgentOrchestrator
 *   │   ├─ ListAgentsAsync()      → [Agent list]
 *   │   ├─ CreateAgentAsync()     → New Agent
 *   │   ├─ GetAgentAsync(id)      → Agent details
 *   │   ├─ RemoveAgentAsync(id)   → Delete agent
 *   │   └─ UpdateAgentToolsAsync()→ Tool access
 *   │
 *   └─ Stream results back to CLI
 *
 * Backend Implementation Details:
 * @see ../../LlmBackend/backend/server.js - Backend routing for /agents endpoints
 * @see ../../LlmBackend/backend/router/agentRouter.js - Agent management routes
 *
 * C# Implementation Details:
 * @see ../../../AgentRuntime.Server/Program.cs - REST endpoints (/api/agents/*)
 * @see ../../../Application/UseCases/MultiAgentOrchestratorHandler.cs - Agent coordination
 *
 * Data Flow Example (agents list):
 * ────────────────────────────────
 * CLI:     > agents list
 *   │
 *   ├─ Frontend (this command)
 *   │   └─ Calls Backend GET /agents
 *   │
 *   ├─ Backend (server.js)
 *   │   └─ GET /agents → checks if C# available
 *   │   └─ Forwards to C#: GET /api/agents
 *   │
 *   ├─ C# Core (Program.cs)
 *   │   └─ app.MapGet("/api/agents", ...)
 *   │   └─ Calls: orchestrator.ListAgentsAsync()
 *   │
 *   ├─ C# IMultiAgentOrchestrator
 *   │   └─ Returns: List of Agent instances
 *   │
 *   ├─ Backend receives
 *   │   └─ Streams response back via SSE
 *   │
 *   └─ CLI displays
 *       [Agent list with names, models, status]
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: 'Manage agent configurations and execution',
  load: () => import('./agents.js'),
} satisfies Command

export default agents
