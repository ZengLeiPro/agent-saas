import type { ContextJson } from '../store/types.js';
import { canonicalJson, fingerprint } from './projector.js';
import {
  DERIVED_ITEM_TYPES,
  DerivedStoreError,
  type DerivedEvidenceRef,
  type DerivedItemCandidate,
  type DerivedItemType,
  type ProposedDistillItem,
} from './types.js';

export interface DistillValidationLookup {
  entityExists(tenantId: string, entityId: string): Promise<boolean>;
  loadEvidence(
    tenantId: string,
    evidence: DerivedEvidenceRef,
  ): Promise<{ exists: boolean; recordVisible: boolean; content: ContextJson } | null>;
}

export interface ProposedDistillValidatorOptions {
  requiredEvidence?: Partial<Record<DerivedItemType, number>>;
  now?: () => Date;
}

/** Admission validator only. Successful output remains proposed and is excluded by default reads. */
export class ProposedDistillValidator {
  private readonly required: Record<DerivedItemType, number>;

  constructor(
    private readonly lookup: DistillValidationLookup,
    private readonly options: ProposedDistillValidatorOptions = {},
  ) {
    this.required = Object.fromEntries(DERIVED_ITEM_TYPES.map(type => [
      type,
      options.requiredEvidence?.[type] ?? 1,
    ])) as Record<DerivedItemType, number>;
  }

  async validate(tenantId: string, proposed: ProposedDistillItem): Promise<DerivedItemCandidate> {
    const itemType = strictItemType(proposed.itemType);
    if (!validId(tenantId) || !validId(proposed.entityId) || !validSemanticKey(proposed.semanticKey)) {
      throw new DerivedStoreError('DERIVED_INVALID');
    }
    if (!await this.lookup.entityExists(tenantId, proposed.entityId)) {
      throw new DerivedStoreError('DERIVED_NOT_FOUND');
    }
    if (proposed.evidence.length < this.required[itemType] || !proposed.quote) {
      throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
    }
    const normalizedQuote = proposed.quote.normalize('NFKC');
    const uniqueEvidence = dedupeEvidence(proposed.evidence);
    if (uniqueEvidence.length !== proposed.evidence.length) {
      throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
    }
    let exactMatches = 0;
    for (const ref of uniqueEvidence) {
      validateEvidenceRef(ref);
      const loaded = await this.lookup.loadEvidence(tenantId, ref);
      if (!loaded?.exists || !loaded.recordVisible) throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
      // This is data comparison only. Prompt-like text has no executable interpretation.
      const normalizedContent = searchableText(loaded.content).normalize('NFKC');
      if (normalizedContent.includes(normalizedQuote)) exactMatches += 1;
    }
    if (exactMatches < this.required[itemType]) throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
    const valueFingerprint = fingerprint(proposed.value);
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString();
    return {
      itemId: `ctx-proposed-${fingerprint([
        tenantId, proposed.entityId, itemType, proposed.semanticKey, valueFingerprint,
        ...uniqueEvidence.map(evidenceKey),
      ])}`,
      entityId: proposed.entityId,
      itemType,
      semanticKey: proposed.semanticKey,
      value: proposed.value,
      valueFingerprint,
      derivation: 'distill',
      authority: 'source',
      state: 'proposed',
      scope: { type: 'org' },
      ...optionalDate('validFrom', proposed.validFrom),
      ...optionalDate('validTo', proposed.validTo),
      ...optionalDate('occurredAt', proposed.occurredAt),
      observedAt,
      evidence: uniqueEvidence,
    };
  }
}

function strictItemType(value: string): DerivedItemType {
  if (!(DERIVED_ITEM_TYPES as readonly string[]).includes(value)) throw new DerivedStoreError('DERIVED_INVALID');
  return value as DerivedItemType;
}

function searchableText(value: ContextJson): string {
  if (typeof value === 'string') return value;
  if (value && !Array.isArray(value) && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }
  return canonicalJson(value);
}

function validId(value: string): boolean {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 500;
}

function validSemanticKey(value: string): boolean {
  return validId(value) && !/[\u0000-\u001f]/u.test(value);
}

function validateEvidenceRef(value: DerivedEvidenceRef): void {
  if (![value.sourceId, value.collectionId, value.recordId, value.evidenceId].every(validId)
    || !Number.isSafeInteger(value.recordRevision) || value.recordRevision < 1) {
    throw new DerivedStoreError('DERIVED_EVIDENCE_INVALID');
  }
}

function dedupeEvidence(values: DerivedEvidenceRef[]): DerivedEvidenceRef[] {
  return [...new Map(values.map(value => [evidenceKey(value), value])).values()];
}

function evidenceKey(value: DerivedEvidenceRef): string {
  return [value.sourceId, value.collectionId, value.recordId, value.recordRevision, value.evidenceId].join('\0');
}

function optionalDate<K extends 'validFrom' | 'validTo' | 'occurredAt'>(key: K, value: string | undefined): { [P in K]?: string } {
  if (!value || !Number.isFinite(Date.parse(value))) return {};
  return { [key]: new Date(value).toISOString() } as { [P in K]?: string };
}
