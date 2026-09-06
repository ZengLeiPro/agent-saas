import { createHash, randomBytes } from 'node:crypto';

import { canonicalize, type Manifest } from '@kaiyan/ky-app-contract';

import type { BillingService } from '../../data/billing/service.js';
import type { PgEntitlementStore } from '../../data/entitlements/store.js';
import type { PgMembershipStore } from '../../data/memberships/store.js';
import type { OrgAgentStore } from '../../data/orgAgents/store.js';
import { provisionTenant } from '../../data/tenants/provision.js';
import type { TenantStore } from '../../data/tenants/store.js';
import type { UserStore } from '../../data/users/store.js';
import type { UserInfo } from '../../data/users/types.js';
import type { GovernanceActor } from '../../data/governance-audit/recorder.js';
import type {
  KyAppCredentialManager,
  KyAppIssuedCredentialTicket,
} from '../installations/credentials.js';
import type { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import type { KyAppInstallationService } from '../installations/service.js';
import {
  evaluateKyAppPublishGate,
  runKyAppToolRegistrationDryRun,
  type KyAppToolRegistrationDryRun,
} from '../systems/publishGate.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import { KyAppMemberImporter, type KyAppMemberImportRow } from './memberImport.js';
import type { KyAppDiagnosticFixture, KyAppDiagnosticReport } from './diagnostics.js';
import {
  PgKyAppDeliveryStore,
  type KyAppOnboardExecution,
  type KyAppOnboardStep,
} from './store.js';

const STEPS = [
  'tenant_admin',
  'credit_grant',
  'system_version',
  'installation_credential',
  'enable',
  'members',
  'skills',
  'smoke',
  'delivery_checklist',
] as const;
type StepId = (typeof STEPS)[number];

export interface KyAppOnboardRequest {
  tenantId: string;
  tenantName: string;
  adminName: string;
  adminPhone: string;
  techContactPhone: string;
  systemId: string;
  installationId: string;
  baseUrl: string;
  origin: string;
  grantCredits: number;
  manifest: Manifest;
  members: KyAppMemberImportRow[];
  diagnostic: Omit<KyAppDiagnosticFixture, 'adminUserId'>;
  suggestedPrompts?: string[];
}

export interface KyAppOnboardResult {
  execution: KyAppOnboardExecution;
  claim?: {
    path: string;
    credentialId: string;
    ticketExpiresAt: string;
    ackDeadlineAt: string;
  };
}

export interface KyAppOnboardServiceOptions {
  store: PgKyAppDeliveryStore;
  systems: PgKyAppSystemStore;
  installations: KyAppInstallationService;
  credentials: KyAppCredentialManager;
  runtimeStore: PgKyAppInstallationRuntimeStore;
  tenants: TenantStore;
  users: UserStore;
  memberships: PgMembershipStore;
  memberImporter: KyAppMemberImporter;
  billing: BillingService;
  sharedDir: string;
  entitlementStore?: PgEntitlementStore;
  orgAgentStore?: OrgAgentStore;
  toolRegistrationDryRun?: KyAppToolRegistrationDryRun;
  verifyTenantSkills?: (
    tenantId: string,
    manifest: Manifest,
  ) => Promise<{
    installed: string[];
    missing: string[];
  }>;
  runSmoke?: (
    installationId: string,
    fixture: KyAppDiagnosticFixture,
  ) => Promise<KyAppDiagnosticReport>;
}

function requestDigest(input: KyAppOnboardRequest): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

function stepsOf(execution: KyAppOnboardExecution): KyAppOnboardStep[] {
  const existing = new Map(execution.steps.map((step) => [step.id, step]));
  return STEPS.map((id) => existing.get(id) ?? { id, status: 'pending' });
}

function setStep(
  steps: KyAppOnboardStep[],
  id: StepId,
  status: KyAppOnboardStep['status'],
  detail?: Record<string, unknown>,
  code?: string,
): void {
  const index = steps.findIndex((step) => step.id === id);
  steps[index] = {
    id,
    status,
    at: new Date().toISOString(),
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {}),
  };
}

export class KyAppOnboardService {
  constructor(private readonly options: KyAppOnboardServiceOptions) {}

  async run(
    input: KyAppOnboardRequest,
    governanceActor: GovernanceActor,
  ): Promise<KyAppOnboardResult> {
    return this.options.store.withExecutionLock(
      `${input.tenantId}:${input.systemId}:${input.installationId}`,
      () => this.runLocked(input, governanceActor),
    );
  }

  private async runLocked(
    input: KyAppOnboardRequest,
    governanceActor: GovernanceActor,
  ): Promise<KyAppOnboardResult> {
    const actorUserId = governanceActor.sub;
    if (input.manifest.systemId !== input.systemId) {
      const error = new Error('manifest.systemId 与 --system 不一致');
      error.name = 'KyAppOnboardConflictError';
      throw error;
    }
    const request = input as unknown as Record<string, unknown>;
    const initial = await this.options.store.createOrResume({
      tenantId: input.tenantId,
      systemId: input.systemId,
      installationId: input.installationId,
      requestDigest: requestDigest(input),
      request,
    });
    let execution = initial.execution;
    if (execution.status === 'completed') return { execution };
    const steps = stepsOf(execution);
    const result = { ...execution.result };

    const save = async (
      status: KyAppOnboardExecution['status'],
      currentStep: StepId,
      errorCode?: string,
    ) => {
      execution = await this.options.store.update({
        executionId: execution.executionId,
        status,
        currentStep,
        steps,
        result,
        ...(errorCode ? { lastErrorCode: errorCode } : { lastErrorCode: null }),
      });
      return execution;
    };

    try {
      const tenant = this.options.tenants.findByIdStrict(input.tenantId);
      if (!tenant) {
        await provisionTenant(
          {
            tenantStore: this.options.tenants,
            sharedDir: this.options.sharedDir,
            ...(this.options.entitlementStore
              ? { entitlementStore: this.options.entitlementStore }
              : {}),
            ...(this.options.orgAgentStore ? { orgAgentStore: this.options.orgAgentStore } : {}),
          },
          { id: input.tenantId, name: input.tenantName, createdBy: actorUserId },
        );
      } else if (tenant.name !== input.tenantName) {
        throw this.conflict('tenant_name_mismatch', '现有组织名称与本次交付参数不一致');
      }
      const admin = await this.ensureAdmin(input, governanceActor);
      result.adminUserId = admin.id;
      setStep(steps, 'tenant_admin', 'completed', {
        adminUserId: admin.id,
        phone: input.adminPhone,
      });
      await save('running', 'credit_grant');

      await this.options.billing.adjustAccount({
        tenantId: input.tenantId,
        creditsDelta: input.grantCredits,
        type: 'grant',
        note: `定制项目 ${input.systemId} 首次交付赠送`,
        actor: actorUserId,
        idempotencyKey: `ky-app:onboard:${input.installationId}:grant`,
      });
      result.grantCredits = input.grantCredits;
      setStep(steps, 'credit_grant', 'completed', { credits: input.grantCredits });
      await save('running', 'system_version');

      const published = await this.ensureSystemVersion(input, actorUserId);
      if (!published.ready) {
        setStep(steps, 'system_version', 'waiting', published.detail, published.code);
        return { execution: await save('waiting_external', 'system_version', published.code) };
      }
      setStep(steps, 'system_version', 'completed', { digest: published.digest });
      await save('running', 'installation_credential');

      const techContact = this.requireSameTenantActiveUser(
        input.techContactPhone,
        input.tenantId,
        '技术联系人',
      );
      let installation = await this.options.systems.getInstallation(input.installationId);
      if (!installation) {
        installation = await this.options.installations.create(
          {
            installationId: input.installationId,
            tenantId: input.tenantId,
            systemId: input.systemId,
            baseUrl: input.baseUrl,
            origin: input.origin,
            techContactUserId: techContact.id,
          },
          governanceActor,
        );
      } else if (
        installation.tenantId !== input.tenantId ||
        installation.systemId !== input.systemId ||
        installation.baseUrl !== input.baseUrl ||
        installation.origin !== input.origin ||
        installation.techContactUserId !== techContact.id
      ) {
        throw this.conflict('installation_mismatch', '现有安装实例与本次交付参数不一致');
      }
      result.domainVerification = installation.domainVerificationToken
        ? {
            recordName: `_ky-app-verify.${new URL(installation.baseUrl).hostname}`,
            recordValue: installation.domainVerificationToken,
          }
        : null;

      const credentials = await this.options.credentials.listRotationDue(input.installationId);
      const allCredentials = await this.options.credentials.listMetadata(input.installationId);
      const active = allCredentials.find((item) => item.status === 'active');
      if (!active) {
        const pending = allCredentials.find((item) => item.status === 'pending_ack');
        if (pending) {
          setStep(
            steps,
            'installation_credential',
            'waiting',
            {
              credentialId: pending.credentialId,
              ackDeadlineAt: pending.ackDeadlineAt,
            },
            'credential_ack_required',
          );
          return {
            execution: await save(
              'waiting_external',
              'installation_credential',
              'credential_ack_required',
            ),
          };
        }
        const issued = await this.options.credentials.issue({
          installationId: input.installationId,
        });
        result.credential = this.credentialMetadata(issued);
        setStep(
          steps,
          'installation_credential',
          'waiting',
          this.credentialMetadata(issued),
          'credential_claim_required',
        );
        const saved = await save(
          'waiting_external',
          'installation_credential',
          'credential_claim_required',
        );
        return {
          execution: saved,
          claim: {
            path: `/api/app-contract/v1/installations/${input.installationId}/credentials/claim/${issued.ticket}`,
            credentialId: issued.credentialId,
            ticketExpiresAt: issued.ticketExpiresAt,
            ackDeadlineAt: issued.ackDeadlineAt,
          },
        };
      }
      result.credential = {
        credentialId: active.credentialId,
        status: active.status,
        ackedAt: active.ackedAt,
        expiresAt: active.expiresAt,
        rotationDue: credentials.some((item) => item.credentialId === active.credentialId),
      };
      setStep(
        steps,
        'installation_credential',
        'completed',
        result.credential as Record<string, unknown>,
      );
      await save('running', 'enable');

      installation = (await this.options.systems.getInstallation(input.installationId))!;
      if (!installation.domainVerifiedAt) {
        const domain = await this.options.installations.probeDomainOwnership(
          new URL(installation.baseUrl).hostname,
          installation.domainVerificationToken!,
        );
        if (!domain.verified) {
          setStep(
            steps,
            'enable',
            'waiting',
            result.domainVerification as Record<string, unknown>,
            'domain_verification_required',
          );
          return {
            execution: await save('waiting_external', 'enable', 'domain_verification_required'),
          };
        }
        installation = (
          await this.options.installations.verifyDomain(input.installationId, governanceActor)
        ).installation;
      }
      const runtime = await this.options.runtimeStore.get(input.installationId);
      if (!runtime || runtime.readyStatus !== 'ok' || runtime.manifestDigest !== published.digest) {
        setStep(steps, 'enable', 'waiting', { expectedDigest: published.digest }, 'ready_required');
        return { execution: await save('waiting_external', 'enable', 'ready_required') };
      }
      if (installation.registeredDigest !== published.digest) {
        installation = await this.options.installations.setRegisteredDigest({
          installationId: input.installationId,
          digest: published.digest,
          observedDigest: runtime.manifestDigest,
          expectedRegisteredDigest: installation.registeredDigest,
          actor: governanceActor,
        });
      }
      if (installation.status !== 'enabled') {
        installation = await this.options.installations.setStatus({
          installationId: input.installationId,
          status: 'enabled',
          actor: governanceActor,
        });
      }
      setStep(steps, 'enable', 'completed', {
        stateVersion: installation.stateVersion,
        digest: installation.registeredDigest,
      });
      await save('running', 'members');

      const memberImport = await this.options.memberImporter.import(
        input.tenantId,
        actorUserId,
        input.members,
      );
      result.memberImport = memberImport as unknown as Record<string, unknown>;
      setStep(steps, 'members', 'completed', {
        total: memberImport.total,
        created: memberImport.created,
        existing: memberImport.existing,
        rejected: memberImport.rejected,
      });
      await save('running', 'skills');

      const skillStatus = this.options.verifyTenantSkills
        ? await this.options.verifyTenantSkills(input.tenantId, input.manifest)
        : { installed: [], missing: (input.manifest.skills ?? []).map((skill) => skill.path) };
      if (skillStatus.missing.length > 0) {
        setStep(steps, 'skills', 'waiting', skillStatus, 'skills_required');
        return { execution: await save('waiting_external', 'skills', 'skills_required') };
      }
      result.skills = skillStatus;
      setStep(steps, 'skills', 'completed', skillStatus);
      await save('running', 'smoke');

      if (!this.options.runSmoke) {
        setStep(steps, 'smoke', 'waiting', undefined, 'diagnostic_unavailable');
        return { execution: await save('waiting_external', 'smoke', 'diagnostic_unavailable') };
      }
      const smoke = await this.options.runSmoke(input.installationId, {
        adminUserId: admin.id,
        ...input.diagnostic,
      });
      result.smoke = smoke;
      if (!smoke.passed) {
        setStep(
          steps,
          'smoke',
          'waiting',
          smoke as unknown as Record<string, unknown>,
          'diagnostic_failed',
        );
        return { execution: await save('waiting_external', 'smoke', 'diagnostic_failed') };
      }
      setStep(steps, 'smoke', 'completed', smoke as unknown as Record<string, unknown>);
      await save('running', 'delivery_checklist');

      const guide = {
        steps: ['打开定制系统', '向 Agent 提出一个真实业务问题', '确认写操作前的审批卡'],
        suggestedPrompts: input.suggestedPrompts?.slice(0, 3) ?? [
          `打开${input.manifest.name}`,
          `查询${input.manifest.name}里的最新业务数据`,
          `告诉我${input.manifest.name}当前有哪些可用能力`,
        ],
      };
      const checklist = {
        tenantAdmin: true,
        credits: true,
        publishedVersion: true,
        credentialAck: true,
        domainVerified: true,
        diagnosticPassed: true,
        enabled: true,
        membersImported: memberImport.rejected === 0,
      };
      await this.options.store.upsertDelivery({
        installationId: input.installationId,
        tenantId: input.tenantId,
        systemId: input.systemId,
        delivered: true,
        checklist,
        memberImport: memberImport as unknown as Record<string, unknown>,
        guide,
      });
      result.checklist = checklist;
      result.guide = guide;
      setStep(steps, 'delivery_checklist', 'completed', checklist);
      return { execution: await save('completed', 'delivery_checklist') };
    } catch (error) {
      const current = STEPS.includes(execution.currentStep as StepId)
        ? (execution.currentStep as StepId)
        : 'tenant_admin';
      setStep(
        steps,
        current,
        'failed',
        undefined,
        error instanceof Error ? error.name : 'internal',
      );
      await save('failed', current, error instanceof Error ? error.name : 'internal');
      throw error;
    }
  }

  private async ensureAdmin(input: KyAppOnboardRequest, governanceActor: GovernanceActor) {
    const actorUserId = governanceActor.sub;
    const crossTenant = this.options.users
      .findAllByPhone(input.adminPhone)
      .find((user) => user.tenantId !== input.tenantId);
    if (crossTenant) throw this.conflict('cross_tenant_phone', '首个管理员手机号已属于其他组织');
    let admin: UserInfo | undefined = this.options.users
      .findAllByPhone(input.adminPhone)
      .find((user) => user.tenantId === input.tenantId);
    if (admin?.disabled)
      throw this.conflict('disabled_admin', '首个管理员账号已停用，不能由 onboarding 自动恢复');
    if (!admin) {
      admin = await this.options.users.create({
        username: input.adminPhone,
        password: randomBytes(24).toString('base64url'),
        role: 'admin',
        realName: input.adminName,
        phone: input.adminPhone,
        phoneVerifiedAt: new Date().toISOString(),
        tenantId: input.tenantId,
        createdBy: actorUserId,
      });
    }
    let membership = await this.options.memberships.getMembership(input.tenantId, admin.id);
    if (!membership) {
      membership = await this.options.memberships.createMembership({
        tenantId: input.tenantId,
        userId: admin.id,
        persona: 'org_admin',
        createdBy: actorUserId,
      });
    }
    if (
      !membership.isOwner ||
      membership.persona !== 'org_admin' ||
      membership.status !== 'active'
    ) {
      await this.options.memberships.updateMembershipIdentity(input.tenantId, admin.id, {
        persona: 'org_admin',
        isOwner: true,
        status: 'active',
        expectedVersion: membership.version,
        updatedBy: actorUserId,
        authorization: {
          kind: 'platform_manage',
          actorTenantId: governanceActor.tenantId ?? '__platform__',
          reason: '定制项目首次交付创建首个组织管理员',
        },
      });
    }
    return admin;
  }

  private async ensureSystemVersion(
    input: KyAppOnboardRequest,
    actorUserId: string,
  ): Promise<
    | { ready: true; digest: string }
    | { ready: false; digest: string; code: string; detail: Record<string, unknown> }
  > {
    const definitionBefore = await this.options.systems.getDefinition(input.systemId);
    const previousVersion = definitionBefore?.publishedDigest
      ? await this.options.systems.getVersion(input.systemId, definitionBefore.publishedDigest)
      : null;
    const previous = previousVersion ? (previousVersion.manifest as unknown as Manifest) : null;
    const gate = evaluateKyAppPublishGate({ previous, next: input.manifest });
    const registered = await this.options.systems.registerVersion({
      systemId: input.systemId,
      name: input.manifest.name,
      manifest: input.manifest as unknown as Record<string, unknown>,
      reviewStatus: gate.reviewRequired ? 'pending' : 'not_required',
      reviewReasons: gate.reasons,
      actor: actorUserId,
    });
    const digest = registered.version.digest;
    if (registered.version.status === 'published') return { ready: true, digest };
    const currentVersion = await this.options.systems.getVersion(input.systemId, digest);
    if (currentVersion?.reviewStatus === 'pending') {
      return {
        ready: false,
        digest,
        code: 'review_required',
        detail: { digest, reviewReasons: currentVersion.reviewReasons },
      };
    }
    const dryRun = await runKyAppToolRegistrationDryRun(
      input.manifest,
      this.options.toolRegistrationDryRun,
    );
    if (dryRun.status !== 'passed') {
      return { ready: false, digest, code: 'tool_dry_run_required', detail: { digest, dryRun } };
    }
    const definition = await this.options.systems.getDefinition(input.systemId);
    if (!definition) throw new Error('KY_APP_SYSTEM_MISSING_AFTER_REGISTER');
    await this.options.systems.publishVersion({
      systemId: input.systemId,
      digest,
      expectedVersion: definition.version,
      actor: actorUserId,
    });
    return { ready: true, digest };
  }

  private requireSameTenantActiveUser(phone: string, tenantId: string, label: string) {
    const users = this.options.users.findAllByPhone(phone);
    const user = users.find((candidate) => candidate.tenantId === tenantId);
    if (!user || user.disabled)
      throw this.conflict('contact_unavailable', `${label}必须是本组织有效成员`);
    if (users.some((candidate) => candidate.tenantId !== tenantId))
      throw this.conflict('cross_tenant_phone', `${label}手机号属于其他组织`);
    return user;
  }

  private credentialMetadata(ticket: KyAppIssuedCredentialTicket): Record<string, unknown> {
    return {
      credentialId: ticket.credentialId,
      keyVersion: ticket.keyVersion,
      ticketExpiresAt: ticket.ticketExpiresAt,
      ackDeadlineAt: ticket.ackDeadlineAt,
      expiresAt: ticket.expiresAt,
    };
  }

  private conflict(code: string, message: string): Error {
    const error = new Error(message);
    error.name = 'KyAppOnboardConflictError';
    (error as Error & { code?: string }).code = code;
    return error;
  }
}
