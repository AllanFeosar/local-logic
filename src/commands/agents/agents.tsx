/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AGENTS COMMAND - Frontend UI Implementation
 *
 * This is the React component that handles agent management UI.
 *
 * Responsibilities:
 * ─────────────────
 * 1. Display interactive agent menu to user
 * 2. Capture user selections (list, create, delete, etc)
 * 3. Make HTTP requests to Backend
 * 4. Handle responses and display results
 * 5. Manage UI state during operations
 *
 * Integration Points:
 * ───────────────────
 * Frontend                        Backend (Node.js)           C# Core
 * ──────────────────────────────────────────────────────────────────
 * AgentsMenu component            /agents endpoints           /api/agents
 * ├─ User selects "list"          GET /agents                 GET /api/agents
 * │  └─ calls Backend API          └─ listAgents()            └─ ListAgentsAsync()
 * │
 * ├─ User selects "create"        POST /agents/create         POST /api/agents/create
 * │  └─ shows input form            └─ validateInput()        └─ CreateAgentAsync()
 * │  └─ calls Backend API            └─ routeToCSharp()       └─ Register agent
 * │
 * ├─ User selects "info <id>"     GET /agents/<id>           GET /api/agents/<id>
 * │  └─ calls Backend API           └─ getAgentAsync()        └─ GetAgentAsync()
 * │
 * ├─ User selects "delete"        DELETE /agents/<id>        DELETE /api/agents/<id>
 * │  └─ confirms with user          └─ validate security      └─ RemoveAgentAsync()
 * │  └─ calls Backend API
 * │
 * └─ User selects "assign-tools"  PUT /agents/<id>/tools     PUT /api/agents/<id>/tools
 *    └─ multi-select UI             └─ updateToolAccess()     └─ UpdateAgentTools()
 *    └─ calls Backend API
 *
 * Key Features:
 * ─────────────
 * ✅ Interactive menu-based UI
 * ✅ Real-time agent status display
 * ✅ Input validation before Backend calls
 * ✅ Error handling with user-friendly messages
 * ✅ Streaming responses for long operations
 * ✅ Tool permission context integration
 *
 * Backend Communication:
 * ──────────────────────
 * All user actions trigger HTTP requests to Backend at http://localhost:3001:
 *   - GET requests return agent lists/details
 *   - POST requests create agents
 *   - DELETE requests remove agents
 *   - PUT requests update agent configuration
 *
 * The Backend (server.js) then:
 *   1. Validates the request
 *   2. Checks if C# Core is available
 *   3. Forwards to C# at http://localhost:5000
 *   4. Streams response back to Frontend
 *   5. Frontend displays results
 *
 * See Also:
 * ─────────
 * @see ../../components/agents/AgentsMenu.tsx - React UI component
 * @see ../../LlmBackend/backend/server.js - Backend /agents routing
 * @see ../../../AgentRuntime.Server/Program.cs - C# REST endpoints
 * @see ../../../Application/Abstractions/IMultiAgentOrchestrator.cs - Agent interface
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import * as React from 'react';
import { AgentsMenu } from '../../components/agents/AgentsMenu.js';
import type { ToolUseContext } from '../../Tool.js';
import { getTools } from '../../tools.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

/**
 * call() - Main entry point for agents command
 *
 * Called by the OpenClaude CLI framework when user types "agents"
 *
 * @param onDone - Callback to close the command when user exits
 * @param context - Tool context with app state and permissions
 * @returns React component for the agents menu UI
 *
 * Flow:
 * 1. Get app state from context
 * 2. Extract tool permissions
 * 3. Get available tools
 * 4. Render interactive agents menu
 * 5. Handle user interactions via AgentsMenu component
 */
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext): Promise<React.ReactNode> {
  // ✅ Get application state
  const appState = context.getAppState();

  // ✅ Extract tool permission context for UI
  const permissionContext = appState.toolPermissionContext;

  // ✅ Get tools available to agents
  const tools = getTools(permissionContext);

  // ✅ Return interactive agents menu
  // AgentsMenu component handles:
  //   - Display agent list
  //   - Capture user selections
  //   - Make Backend API calls (via fetch or http client)
  //   - Display results
  //   - Handle errors
  return <AgentsMenu tools={tools} onExit={onDone} />;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkFnZW50c01lbnUiLCJUb29sVXNlQ29udGV4dCIsImdldFRvb2xzIiwiTG9jYWxKU1hDb21tYW5kT25Eb25lIiwiY2FsbCIsIm9uRG9uZSIsImNvbnRleHQiLCJQcm9taXNlIiwiUmVhY3ROb2RlIiwiYXBwU3RhdGUiLCJnZXRBcHBTdGF0ZSIsInBlcm1pc3Npb25Db250ZXh0IiwidG9vbFBlcm1pc3Npb25Db250ZXh0IiwidG9vbHMiXSwic291cmNlcyI6WyJhZ2VudHMudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQWdlbnRzTWVudSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvYWdlbnRzL0FnZW50c01lbnUuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xVc2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vVG9vbC5qcydcbmltcG9ydCB7IGdldFRvb2xzIH0gZnJvbSAnLi4vLi4vdG9vbHMuanMnXG5pbXBvcnQgdHlwZSB7IExvY2FsSlNYQ29tbWFuZE9uRG9uZSB9IGZyb20gJy4uLy4uL3R5cGVzL2NvbW1hbmQuanMnXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYWxsKFxuICBvbkRvbmU6IExvY2FsSlNYQ29tbWFuZE9uRG9uZSxcbiAgY29udGV4dDogVG9vbFVzZUNvbnRleHQsXG4pOiBQcm9taXNlPFJlYWN0LlJlYWN0Tm9kZT4ge1xuICBjb25zdCBhcHBTdGF0ZSA9IGNvbnRleHQuZ2V0QXBwU3RhdGUoKVxuICBjb25zdCBwZXJtaXNzaW9uQ29udGV4dCA9IGFwcFN0YXRlLnRvb2xQZXJtaXNzaW9uQ29udGV4dFxuICBjb25zdCB0b29scyA9IGdldFRvb2xzKHBlcm1pc3Npb25Db250ZXh0KVxuXG4gIHJldHVybiA8QWdlbnRzTWVudSB0b29scz17dG9vbHN9IG9uRXhpdD17b25Eb25lfSAvPlxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLFVBQVUsUUFBUSx1Q0FBdUM7QUFDbEUsY0FBY0MsY0FBYyxRQUFRLGVBQWU7QUFDbkQsU0FBU0MsUUFBUSxRQUFRLGdCQUFnQjtBQUN6QyxjQUFjQyxxQkFBcUIsUUFBUSx3QkFBd0I7QUFFbkUsT0FBTyxlQUFlQyxJQUFJQSxDQUN4QkMsTUFBTSxFQUFFRixxQkFBcUIsRUFDN0JHLE9BQU8sRUFBRUwsY0FBYyxDQUN4QixFQUFFTSxPQUFPLENBQUNSLEtBQUssQ0FBQ1MsU0FBUyxDQUFDLENBQUM7RUFDMUIsTUFBTUMsUUFBUSxHQUFHSCxPQUFPLENBQUNJLFdBQVcsQ0FBQyxDQUFDO0VBQ3RDLE1BQU1DLGlCQUFpQixHQUFHRixRQUFRLENBQUNHLHFCQUFxQjtFQUN4RCxNQUFNQyxLQUFLLEdBQUdYLFFBQVEsQ0FBQ1MsaUJBQWlCLENBQUM7RUFFekMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQ0UsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUNSLE1BQU0sQ0FBQyxHQUFHO0FBQ3JEIiwiaWdub3JlTGlzdCI6W119