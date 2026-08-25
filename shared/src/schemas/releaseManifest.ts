import { z } from "zod";

/** Components which are released as one coordinated unit. */
export const releaseComponentSchema = z.enum(["web", "api", "runtimeWorker", "acs"]);
export const RELEASE_COMPONENTS = ["web", "api", "runtimeWorker", "acs"] as const;

/** A human-readable, stable release identifier. */
export const releaseIdSchema = z.string().trim().min(1).max(128);

/** A complete Git object ID. Git SHA-1 hexadecimal is case-insensitive. */
export const fullShaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/, "Expected a complete 40-character SHA");

/** A content digest whose encoding is stable across runtimes. */
export const sha256DigestSchema = z.string().regex(
  /^sha256:[a-f0-9]{64}$/,
  "Expected a sha256:<lowercase hexadecimal> digest",
);

export const releaseComponentSourcesSchema = z.object({
  web: fullShaSchema,
  api: fullShaSchema,
  runtimeWorker: fullShaSchema,
  acs: fullShaSchema,
}).strict();

export const releaseComponentPlanSchema = z.object({
  action: z.enum(["deploy", "keep"]),
  sourceSha: fullShaSchema,
}).strict();

export const releaseComponentsPlanSchema = z.object({
  web: releaseComponentPlanSchema,
  api: releaseComponentPlanSchema,
  runtimeWorker: releaseComponentPlanSchema,
  acs: releaseComponentPlanSchema,
}).strict();

/** A verifiable build output associated with a release. */
export const releaseArtifactSchema = z.object({
  id: releaseIdSchema,
  component: releaseComponentSchema,
  uri: z.string().trim().min(1).max(2_000),
  digest: sha256DigestSchema,
}).strict();

/**
 * Contract for a coordinated release. A deploy always comes from releaseSha;
 * a kept component always remains at its production baseline.
 */
export const releaseManifestSchema = z.object({
  releaseId: releaseIdSchema,
  releaseSha: fullShaSchema,
  digest: sha256DigestSchema,
  productionBaseline: releaseComponentSourcesSchema,
  components: releaseComponentsPlanSchema,
  rollbackTargets: releaseComponentSourcesSchema,
  artifacts: z.array(releaseArtifactSchema).max(100).optional(),
}).strict().superRefine((manifest, ctx) => {
  for (const component of RELEASE_COMPONENTS) {
    const plan = manifest.components[component];
    const expectedSha = plan.action === "deploy"
      ? manifest.releaseSha
      : manifest.productionBaseline[component];

    if (plan.sourceSha !== expectedSha) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components", component, "sourceSha"],
        message: plan.action === "deploy"
          ? "deploy sourceSha must equal releaseSha"
          : "keep sourceSha must equal the component productionBaseline",
      });
    }
  }
});

export type ReleaseComponent = z.infer<typeof releaseComponentSchema>;
export type ReleaseComponentSources = z.infer<typeof releaseComponentSourcesSchema>;
export type ReleaseComponentPlan = z.infer<typeof releaseComponentPlanSchema>;
export type ReleaseComponentsPlan = z.infer<typeof releaseComponentsPlanSchema>;
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function normalizeCanonicalJson(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not allow non-finite numbers");
    return value;
  }

  if (Array.isArray(value)) {
    const normalized: CanonicalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("Canonical JSON does not allow sparse arrays");
      normalized.push(normalizeCanonicalJson(value[index]));
    }
    return normalized;
  }

  if (typeof value !== "object") {
    throw new TypeError("Canonical JSON only supports JSON values");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON only supports plain objects");
  }

  const normalized: { [key: string]: CanonicalJsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeCanonicalJson((value as Record<string, unknown>)[key]);
  }
  return normalized;
}

/**
 * Serializes JSON deterministically by recursively sorting object keys. Array
 * order is intentionally preserved. Hashing is deliberately left to callers.
 */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(normalizeCanonicalJson(value));
  if (serialized === undefined) throw new TypeError("Canonical JSON serialization failed");
  return serialized;
}

/** Alias for callers that prefer a verb-oriented name. */
export const canonicalizeJson = canonicalJson;
