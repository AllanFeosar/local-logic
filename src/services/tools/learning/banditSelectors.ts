/**
 * Multi-armed bandit tool selectors.
 *
 * Ported from the AgentRuntime.Server C# prototype (Infrastructure/Learning/
 * ToolSelectorEpsilonGreedy.cs, ToolSelectorThompson.cs) — same math, same
 * phase thresholds. That C# code was reviewed and found complete/correct;
 * this port keeps it faithful rather than "improving" it blind.
 *
 * Neither selector picks *which* tool the model should call next (the model
 * already does that via native tool-calling) — they answer a different
 * question: "of the tools available for this kind of action, which has
 * historically worked best?" That signal is meant to be surfaced (e.g. a
 * ranking hint) or used to bias between genuinely interchangeable tools,
 * not to override the model's own judgment.
 */

export interface ToolSelector {
  selectBestTool(
    availableTools: string[],
    requestedAction: string,
  ): string | null
  updateReward(toolName: string, succeeded: boolean): void
  getSelectionScores(availableTools: string[]): Map<string, number>
  reset(): void
}

/**
 * Epsilon-Greedy: with probability (1 - epsilon) pick the tool with the best
 * Laplace-smoothed success rate; with probability epsilon pick uniformly at
 * random. Simple, low overhead, blind exploration (doesn't prioritize
 * uncertain tools the way Thompson sampling does).
 */
export class ToolSelectorEpsilonGreedy implements ToolSelector {
  private readonly toolStats = new Map<
    string,
    { successes: number; failures: number }
  >()
  private readonly epsilon: number

  /** @param epsilon Exploration probability (0.0 = pure greedy, 0.5 = 50% explore) */
  constructor(epsilon = 0.1) {
    if (epsilon < 0 || epsilon > 1) {
      throw new RangeError('epsilon must be between 0 and 1')
    }
    this.epsilon = epsilon
  }

  selectBestTool(
    availableTools: string[],
    _requestedAction: string,
  ): string | null {
    if (availableTools.length === 0) return null

    if (Math.random() < this.epsilon) {
      // EXPLORATION: pick a random tool
      return availableTools[Math.floor(Math.random() * availableTools.length)]!
    }

    // EXPLOITATION: pick the best tool by smoothed success rate
    const scores = this.getSelectionScores(availableTools)
    let best = availableTools[0]!
    let bestScore = -Infinity
    for (const tool of availableTools) {
      const score = scores.get(tool) ?? 0
      if (score > bestScore) {
        bestScore = score
        best = tool
      }
    }
    return best
  }

  updateReward(toolName: string, succeeded: boolean): void {
    const stats = this.getStats(toolName)
    if (succeeded) stats.successes++
    else stats.failures++
    this.toolStats.set(toolName, stats)
  }

  getSelectionScores(availableTools: string[]): Map<string, number> {
    const scores = new Map<string, number>()
    for (const tool of availableTools) {
      const { successes, failures } = this.getStats(tool)
      const total = successes + failures
      // Laplace smoothing: (successes + 1) / (total + 2)
      scores.set(tool, (successes + 1) / (total + 2))
    }
    return scores
  }

  reset(): void {
    this.toolStats.clear()
  }

  private getStats(toolName: string): { successes: number; failures: number } {
    return this.toolStats.get(toolName) ?? { successes: 0, failures: 0 }
  }
}

/**
 * Thompson Sampling: each tool has a Beta(successes+1, failures+1) posterior
 * over its success probability. Selection samples once from each tool's
 * posterior and picks the highest draw — this naturally balances
 * exploration (wide posteriors for under-sampled tools get sampled high
 * sometimes) and exploitation (narrow, high-mean posteriors usually win)
 * without a tunable epsilon.
 *
 * Reference: Chapelle & Li, "An Empirical Evaluation of Thompson Sampling" (2011).
 */
export class ToolSelectorThompson implements ToolSelector {
  private readonly posteriors = new Map<
    string,
    { successes: number; failures: number }
  >()

  selectBestTool(
    availableTools: string[],
    _requestedAction: string,
  ): string | null {
    if (availableTools.length === 0) return null

    let best = availableTools[0]!
    let bestSample = -Infinity
    for (const tool of availableTools) {
      const { successes, failures } = this.getPosterior(tool)
      const sample = sampleBeta(successes + 1, failures + 1)
      if (sample > bestSample) {
        bestSample = sample
        best = tool
      }
    }
    return best
  }

  updateReward(toolName: string, succeeded: boolean): void {
    const posterior = this.getPosterior(toolName)
    if (succeeded) posterior.successes++
    else posterior.failures++
    this.posteriors.set(toolName, posterior)
  }

  /** Expected value of each tool's posterior: E[theta] = alpha / (alpha + beta). */
  getSelectionScores(availableTools: string[]): Map<string, number> {
    const scores = new Map<string, number>()
    for (const tool of availableTools) {
      const { successes, failures } = this.getPosterior(tool)
      scores.set(tool, (successes + 1) / (successes + failures + 2))
    }
    return scores
  }

  reset(): void {
    this.posteriors.clear()
  }

  private getPosterior(
    toolName: string,
  ): { successes: number; failures: number } {
    return this.posteriors.get(toolName) ?? { successes: 0, failures: 0 }
  }
}

/**
 * Sample from Beta(alpha, beta) via two independent Gamma draws:
 * Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b)).
 */
function sampleBeta(alpha: number, beta: number): number {
  const gammaAlpha = sampleGamma(alpha)
  const gammaBeta = sampleGamma(beta)
  return gammaAlpha / (gammaAlpha + gammaBeta)
}

/** Sample from Gamma(k, theta=1) via Marsaglia & Tsang (2000) for k>=1. */
function sampleGamma(k: number): number {
  if (k < 1) return 0

  if (k <= 3) {
    // Gamma(k) for small integer-ish k = sum of k independent Exponential(1)
    let sum = 0
    for (let i = 0; i < k; i++) {
      sum -= Math.log(Math.random())
    }
    return sum
  }

  const d = k - 1 / 3
  const c = 1 / Math.sqrt(9 * d)

  for (;;) {
    let v: number
    let z: number
    do {
      z = sampleNormal()
      v = 1 + c * z
    } while (v <= 0)
    v = v * v * v

    const u = Math.random()
    if (u < 1 - 0.0331 * z * z * z * z) return d * v
    if (Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v
  }
}

/** Standard normal sample via Box-Muller. */
function sampleNormal(): number {
  const u1 = Math.random()
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}
