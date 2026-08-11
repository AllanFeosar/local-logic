/**
 * Bedrock utilities — pure string/ARN helpers only.
 *
 * MIGRATED (Phase 5): All AWS SDK client creation has been removed from the
 * Frontend. Bedrock API calls now go through:
 *   Frontend → backendClient.ts → Backend (port 3001) → bedrockRouter.js → AWS
 *
 * What was removed:
 *   - createBedrockClient()          → backend/services/awsCredentials.js
 *   - createBedrockRuntimeClient()   → backend/router/bedrockRouter.js
 *   - getBedrockInferenceProfiles()  → GET /api/bedrock/profiles (backend)
 *   - getInferenceProfileBackingModel() → backend/router/bedrockRouter.js
 *
 * What remains: pure string/ARN utilities that have no AWS SDK dependency.
 */

// ─── Backward-compatible stubs (no AWS SDK) ───────────────────────────────────
// These keep existing callers (claude.ts, tokenEstimation.ts, modelStrings.ts)
// working without changes. The real work happens in the Backend.

/**
 * @deprecated AWS SDK removed from Frontend. Backend handles Bedrock profiles.
 * Callers that need profiles should use GET /api/bedrock/profiles via backendClient.
 * Returns [] so modelStrings.ts gracefully falls back to hardcoded Bedrock IDs.
 */
export async function getBedrockInferenceProfiles(): Promise<string[]> {
  return []
}

/**
 * @deprecated AWS SDK removed from Frontend. Backend handles inference profiles.
 * Returns null so callers (tokenEstimation.ts, claude.ts) skip Bedrock-specific paths.
 */
export async function getInferenceProfileBackingModel(
  _profileId: string,
): Promise<string | null> {
  return null
}

/**
 * @deprecated AWS SDK removed from Frontend. Bedrock token counting now goes
 * through Backend. Throws so tokenEstimation.ts try/catch skips Bedrock path.
 */
export async function createBedrockRuntimeClient(): Promise<never> {
  throw new Error(
    'Bedrock SDK removed from Frontend. Token counting via Bedrock is handled by the Backend. ' +
    'Use backendClient.chat() or the Backend count-tokens endpoint.',
  )
}

export function findFirstMatch(
  profiles: string[],
  substring: string,
): string | null {
  return profiles.find(p => p.includes(substring)) ?? null
}

/**
 * Check if a model ID is a foundation model (e.g., "anthropic.claude-sonnet-4-5-20250929-v1:0")
 */
export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

/**
 * Cross-region inference profile prefixes for Bedrock.
 * These prefixes allow routing requests to models in specific regions.
 */
const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const

/**
 * Extract the model/inference profile ID from a Bedrock ARN.
 * If the input is not an ARN, returns it unchanged.
 *
 * ARN format: arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
 * Also handles: arn:aws:bedrock:<region>:<account>:application-inference-profile/<profile-id>
 * And foundation model ARNs: arn:aws:bedrock:<region>::foundation-model/<model-id>
 */
export function extractModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith('arn:')) {
    return modelId
  }
  const lastSlashIndex = modelId.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return modelId
  }
  return modelId.substring(lastSlashIndex + 1)
}

export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

/**
 * Extract the region prefix from a Bedrock cross-region inference model ID.
 * Handles both plain model IDs and full ARN format.
 * For example:
 * - "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" → "eu"
 * - "us.anthropic.claude-3-7-sonnet-20250219-v1:0" → "us"
 * - "arn:aws:bedrock:ap-northeast-2:123:inference-profile/global.anthropic.claude-opus-4-6-v1" → "global"
 * - "anthropic.claude-3-5-sonnet-20241022-v2:0" → undefined (foundation model)
 * - "claude-sonnet-4-5-20250929" → undefined (first-party format)
 */
export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  // Extract the inference profile ID from ARN format if present
  // ARN format: arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
  const effectiveModelId = extractModelIdFromArn(modelId)

  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (effectiveModelId.startsWith(`${prefix}.anthropic.`)) {
      return prefix
    }
  }
  return undefined
}

/**
 * Apply a region prefix to a Bedrock model ID.
 * If the model already has a different region prefix, it will be replaced.
 * If the model is a foundation model (anthropic.*), the prefix will be added.
 * If the model is not a Bedrock model, it will be returned as-is.
 *
 * For example:
 * - applyBedrockRegionPrefix("us.anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("claude-sonnet-4-5-20250929", "eu") → "claude-sonnet-4-5-20250929" (not a Bedrock model)
 */
export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  // Check if it already has a region prefix and replace it
  const existingPrefix = getBedrockRegionPrefix(modelId)
  if (existingPrefix) {
    return modelId.replace(`${existingPrefix}.`, `${prefix}.`)
  }

  // Check if it's a foundation model (anthropic.*) and add the prefix
  if (isFoundationModel(modelId)) {
    return `${prefix}.${modelId}`
  }

  // Not a Bedrock model format, return as-is
  return modelId
}
