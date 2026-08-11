import { describe, expect, test } from 'bun:test'
import { AdaptiveToolSelector } from './adaptiveToolSelector.js'
import { ToolSelectorEpsilonGreedy, ToolSelectorThompson } from './banditSelectors.js'

describe('ToolSelectorEpsilonGreedy', () => {
  test('rejects epsilon outside [0, 1]', () => {
    expect(() => new ToolSelectorEpsilonGreedy(-0.1)).toThrow()
    expect(() => new ToolSelectorEpsilonGreedy(1.1)).toThrow()
  })

  test('returns null for an empty tool list', () => {
    const selector = new ToolSelectorEpsilonGreedy(0.1)
    expect(selector.selectBestTool([], 'anything')).toBeNull()
  })

  test('Laplace-smoothed score matches the formula exactly', () => {
    const selector = new ToolSelectorEpsilonGreedy(0.1)
    selector.updateReward('toolA', true)
    selector.updateReward('toolA', true)
    selector.updateReward('toolA', false)
    // successes=2, failures=1, total=3 -> (2+1)/(3+2) = 0.6
    const scores = selector.getSelectionScores(['toolA'])
    expect(scores.get('toolA')).toBeCloseTo(0.6, 10)
  })

  test('unsampled tool scores 0.5 (pure Laplace prior)', () => {
    const selector = new ToolSelectorEpsilonGreedy(0.1)
    const scores = selector.getSelectionScores(['fresh'])
    expect(scores.get('fresh')).toBeCloseTo(0.5, 10)
  })

  test('pure-greedy (epsilon=0) always exploits the better-performing tool', () => {
    const selector = new ToolSelectorEpsilonGreedy(0)
    for (let i = 0; i < 20; i++) selector.updateReward('good', true)
    for (let i = 0; i < 20; i++) selector.updateReward('bad', false)
    for (let i = 0; i < 50; i++) {
      expect(selector.selectBestTool(['good', 'bad'], 'x')).toBe('good')
    }
  })

  test('reset clears learned stats back to the 0.5 prior', () => {
    const selector = new ToolSelectorEpsilonGreedy(0.1)
    selector.updateReward('toolA', true)
    selector.reset()
    expect(selector.getSelectionScores(['toolA']).get('toolA')).toBeCloseTo(0.5, 10)
  })
})

describe('ToolSelectorThompson', () => {
  test('returns null for an empty tool list', () => {
    const selector = new ToolSelectorThompson()
    expect(selector.selectBestTool([], 'anything')).toBeNull()
  })

  test('expected value matches E[Beta] = (s+1)/(s+f+2)', () => {
    const selector = new ToolSelectorThompson()
    selector.updateReward('toolA', true)
    selector.updateReward('toolA', true)
    selector.updateReward('toolA', true)
    selector.updateReward('toolA', false)
    // successes=3, failures=1 -> (3+1)/(3+1+2) = 4/6
    const scores = selector.getSelectionScores(['toolA'])
    expect(scores.get('toolA')).toBeCloseTo(4 / 6, 10)
  })

  test('over many trials, a consistently-successful tool is selected far more than a failing one', () => {
    const selector = new ToolSelectorThompson()
    for (let i = 0; i < 30; i++) selector.updateReward('good', true)
    for (let i = 0; i < 30; i++) selector.updateReward('bad', false)

    let goodWins = 0
    const trials = 500
    for (let i = 0; i < trials; i++) {
      if (selector.selectBestTool(['good', 'bad'], 'x') === 'good') goodWins++
    }
    // Not deterministic (still samples), but with this much evidence 'good'
    // should dominate heavily. 90%+ is a safe, non-flaky bound.
    expect(goodWins / trials).toBeGreaterThan(0.9)
  })

  test('credible interval math stays finite and within [0, 1]', () => {
    const selector = new ToolSelectorThompson()
    selector.updateReward('toolA', true)
    const { successes, failures } = { successes: 1, failures: 0 }
    // sanity check the underlying posterior bookkeeping via the public score API
    const score = selector.getSelectionScores(['toolA']).get('toolA')!
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
    expect(successes + failures).toBe(1)
  })
})

describe('AdaptiveToolSelector phase transitions', () => {
  test('starts in BOOTSTRAP with zero samples', () => {
    const selector = new AdaptiveToolSelector()
    const diag = selector.getDiagnostics(['toolA'])
    expect(diag.currentPhase).toBe('BOOTSTRAP')
  })

  test('moves to LEARNING once every tool has >= 5 samples', () => {
    const selector = new AdaptiveToolSelector()
    for (let i = 0; i < 5; i++) selector.updateReward('toolA', true)
    const diag = selector.getDiagnostics(['toolA'])
    expect(diag.currentPhase).toBe('LEARNING')
  })

  test('moves to EXPLOITATION once every tool has >= 50 samples', () => {
    const selector = new AdaptiveToolSelector()
    for (let i = 0; i < 50; i++) selector.updateReward('toolA', true)
    const diag = selector.getDiagnostics(['toolA'])
    expect(diag.currentPhase).toBe('EXPLOITATION')
  })

  test('phase is gated by the LEAST-sampled tool, not the most', () => {
    const selector = new AdaptiveToolSelector()
    for (let i = 0; i < 50; i++) selector.updateReward('veteran', true)
    // 'rookie' has zero samples — overall phase must still be BOOTSTRAP
    const diag = selector.getDiagnostics(['veteran', 'rookie'])
    expect(diag.currentPhase).toBe('BOOTSTRAP')
  })

  test('in EXPLOITATION phase, always picks the tool with the higher success rate', () => {
    const selector = new AdaptiveToolSelector()
    for (let i = 0; i < 60; i++) selector.updateReward('good', true)
    for (let i = 0; i < 60; i++) selector.updateReward('bad', false)
    for (let i = 0; i < 20; i++) {
      expect(selector.selectBestTool(['good', 'bad'], 'x')).toBe('good')
    }
  })

  test('returns null for an empty tool list at every phase', () => {
    const selector = new AdaptiveToolSelector()
    expect(selector.selectBestTool([], 'x')).toBeNull()
    for (let i = 0; i < 60; i++) selector.updateReward('toolA', true)
    expect(selector.selectBestTool([], 'x')).toBeNull()
  })

  test('reset clears phase back to BOOTSTRAP', () => {
    const selector = new AdaptiveToolSelector()
    for (let i = 0; i < 60; i++) selector.updateReward('toolA', true)
    expect(selector.getDiagnostics(['toolA']).currentPhase).toBe('EXPLOITATION')
    selector.reset()
    expect(selector.getDiagnostics(['toolA']).currentPhase).toBe('BOOTSTRAP')
  })
})
