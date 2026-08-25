import { describe, expect, it } from "vitest";
import { canonicalJson, releaseManifestSchema } from "./releaseManifest";

const RELEASE_SHA = "a".repeat(40);
const BASELINE_SHA = "b".repeat(40);
const ROLLBACK_SHA = "c".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;

function componentSources(sha: string) {
  return {
    web: sha,
    api: sha,
    runtimeWorker: sha,
    acs: sha,
  };
}

function validManifest() {
  const productionBaseline = componentSources(BASELINE_SHA);
  return {
    releaseId: "release-20260825.1",
    releaseSha: RELEASE_SHA,
    digest: DIGEST,
    productionBaseline,
    components: {
      web: { action: "deploy" as const, sourceSha: RELEASE_SHA },
      api: { action: "keep" as const, sourceSha: productionBaseline.api },
      runtimeWorker: { action: "deploy" as const, sourceSha: RELEASE_SHA },
      acs: { action: "keep" as const, sourceSha: productionBaseline.acs },
    },
    rollbackTargets: componentSources(ROLLBACK_SHA),
    artifacts: [{
      id: "web-build",
      component: "web" as const,
      uri: "https://artifacts.example.test/releases/web.tgz",
      digest: DIGEST,
    }],
  };
}

describe("releaseManifestSchema", () => {
  it("accepts all four component sections and artifacts", () => {
    expect(releaseManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it("rejects a non-complete release SHA", () => {
    expect(releaseManifestSchema.safeParse({ ...validManifest(), releaseSha: "abc123" }).success).toBe(false);
  });

  it("rejects a malformed sha256 digest", () => {
    expect(releaseManifestSchema.safeParse({ ...validManifest(), digest: "sha256:ABC" }).success).toBe(false);
  });

  it("requires deploy sourceSha to match releaseSha", () => {
    const manifest = validManifest();
    manifest.components.web.sourceSha = BASELINE_SHA;

    const result = releaseManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path.join("."))).toContain("components.web.sourceSha");
    }
  });

  it("requires keep sourceSha to match that component's productionBaseline", () => {
    const manifest = validManifest();
    manifest.components.api.sourceSha = RELEASE_SHA;

    const result = releaseManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path.join("."))).toContain("components.api.sourceSha");
    }
  });

  it("rejects component maps which do not cover all four components", () => {
    const manifest = validManifest();
    const { acs, ...missingAcs } = manifest.rollbackTargets;
    void acs;

    expect(releaseManifestSchema.safeParse({ ...manifest, rollbackTargets: missingAcs }).success).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("recursively sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }, "first", "second"] }))
      .toBe('{"a":[{"x":1,"y":2},"first","second"],"z":{"a":1,"b":2}}');
  });

  it("rejects values which JSON would silently coerce", () => {
    expect(() => canonicalJson({ number: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ missing: undefined })).toThrow(TypeError);
  });
});
