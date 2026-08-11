/**
 * Adaptive tool selector: switches bandit strategy by confidence phase.
 *
 * Ported from AgentRuntime.Server C# (Infrastructure/Learning/AdaptiveToolSelector.cs).
 *
 *   BOOTSTRAP   (< 5 samples for the least-tried tool): Epsilon-Greedy — explore widely
 *   LEARNING    (5-50 samples): Thompson Sampling — balanced explore/exploit
 *   EXPLOITATION (> 50 samples): Greedy — pick the highest-scoring tool outright
 *
 * This isn't a router that decides which tool the model calls — openclaude's
 * tool-calling already goes through the model's own judgment. It's a
 * side-channel ranking signal: which of a set of genuinely interchangeable
 * tools has actually worked, historically, for this kind of action. Feed
 * `getSelectionScores()` into a ranking hint; don't use it to silently
 * swap what the model asked to call.
 */

import {
  type ToolSelector,
  ToolSelectorEpsilonGreedy,
  ToolSelectorThompson,
} from './banditSelectors.js'

const BOOTSTRAP_THRESHOLD = 5
const EXPLOITATION_THRESHOLD = 50

export class AdaptiveToolSelector implements ToolSelector {
  private readonly epsilonGreedy: ToolSelectorEpsilonGreedy
  private readonly thompson: ToolSelectorThompson
  private readonly sampleCounts = new Map<string, number>()

  constructor(epsilon = 0.15) {
    this.epsilonGreedy = new ToolSelectorEpsilonGreedy(epsilon)
    this.thompson = new ToolSelectorThompson()
  }

  selectBestTool(
    availableTools: string[],
    requestedAction: string,
  ): string | null {
    if (availableTools.length === 0) return null

    const minSamples = Math.min(
      ...availableTools.map(t => this.getSampleCount(t)),
    )

    if (minSamples < BOOTSTRAP_THRESHOLD) {
      return this.epsilonGreedy.selectBestTool(availableTools, requestedAction)
    }
    if (minSamples < EXPLOITATION_THRESHOLD) {
      return this.thompson.selectBestTool(availableTools, requestedAction)
    }

    // EXPLOITATION: pure greedy on Thompson's expected values
    const scores = this.thompson.getSelectionScores(availableTools)
    let best = availableTools[0]!
    let bestScore = -1
    for (const tool of availableTools) {
      const score = scores.get(tool) ?? -1
      if (score > bestScore) {
        bestScore = score
        best = tool
      }
    }
    return best
  }

  updateReward(toolName: string, succeeded: boolean): void {
    this.epsilonGreedy.updateReward(toolName, succeeded)
    this.thompson.updateReward(toolName, succeeded)
    this.sampleCounts.set(toolName, this.getSampleCount(toolName) + 1)
  }

  /** Thompson's expected probabilities — more principled than raw counts. */
  getSelectionScores(availableTools: string[]): Map<string, number> {
    return this.thompson.getSelectionScores(availableTools)
  }

  reset(): void {
    this.epsilonGreedy.reset()
    this.thompson.reset()
    this.sampleCounts.clear()
  }

  private getSampleCount(toolName: string): number {
    return this.sampleCounts.get(toolName) ?? 0
  }

  /** Diagnostics: current phase + per-tool sample counts + scores, for debugging/telemetry. */
  getDiagnostics(availableTools: string[]): {
    currentPhase: 'BOOTSTRAP' | 'LEARNING' | 'EXPLOITATION'
    sampleCounts: Map<string, number>
    scores: Map<string, number>
  } {
    const minSamples =
      availableTools.length > 0
        ? Math.min(...availableTools.map(t => this.getSampleCount(t)))
        : 0
    const currentPhase =
      minSamples < BOOTSTRAP_THRESHOLD
        ? 'BOOTSTRAP'
        : minSamples < EXPLOITATION_THRESHOLD
          ? 'LEARNING'
          : 'EXPLOITATION'

    return {
      currentPhase,
      sampleCounts: new Map(this.sampleCounts),
      scores: this.getSelectionScores(availableTools),
    }
  }
}
