import { createHash } from 'node:crypto';
import { canonicalize, type Manifest } from '@kaiyan/ky-app-contract';
import type { KyAppOnboardServiceOptions, KyAppOnboardResult } from './onboard.js';
import type { KyAppOnboardExecution, KyAppOnboardStep } from './store.js';
import { installableScope } from '../installations/managementPolicy.js';
import { assertBaseUrl, assertOrigin, KyAppInstallationError } from '../installations/service.js';
import { KyAppSystemConflictError, KyAppSystemNotFoundError } from '../systems/types.js';
import { connectionAddress, type PgKyAppConnectionSettingsStore } from './connectionSettings.js';
import type { KyAppPlatformConfig } from '../config.js';
import type { GovernanceActor } from '../../data/governance-audit/recorder.js';

export interface ExistingOnboardInput {
  systemId: string;
  tenantId: string;
  techContactUserId: string;
  expectedSettingsVersion: number;
  expectedDigest: string;
  deployment?: { baseUrl: string; origin: string };
}
interface FrozenRequest extends Record<string, unknown> {
  mode: 'existing';
  systemId: string;
  tenantId: string;
  techContactUserId: string;
  installationId: string;
  baseUrl: string;
  origin: string;
  digest: string;
}
export type ExistingOnboardOptions = Pick<
  KyAppOnboardServiceOptions,
  | 'store'
  | 'systems'
  | 'installations'
  | 'credentials'
  | 'runtimeStore'
  | 'tenants'
  | 'users'
  | 'memberships'
  | 'entitlementStore'
  | 'getAssignmentConfigured'
  | 'runSmoke'
> & {
  settings: PgKyAppConnectionSettingsStore;
  config: KyAppPlatformConfig;
};
const stepIds = [
  'existing_organization',
  'installation_credential',
  'enable',
  'assignments',
  'smoke',
  'delivery_checklist',
];

/** 已有组织接入不具有创建组织、创建账号、赠送积分或扩大权益的依赖。 */
export class KyAppExistingOnboardService {
  constructor(private readonly options: ExistingOnboardOptions) {}

  async organizationOptions(systemId: string, tenantId: string) {
    if (!(await this.options.systems.getDefinition(systemId)))
      throw new KyAppSystemNotFoundError('未知业务系统');
    const tenant = this.requireTenant(tenantId);
    const [memberships, installations, allows] = await Promise.all([
      this.options.memberships.listMemberships(tenantId),
      this.options.systems.listInstallationsForTenant(tenantId),
      installableScope(this.options.entitlementStore, tenantId),
    ]);
    const members = memberships
      .flatMap((membership) => {
        const user = this.options.users.findById(membership.userId);
        return membership.status === 'active' &&
          user &&
          !user.disabled &&
          user.tenantId === tenantId
          ? [
              {
                userId: user.id,
                name: user.realName || user.username,
                isAdmin: membership.persona === 'org_admin' || membership.isOwner,
              },
            ]
          : [];
      })
      .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name));
    const installation = installations.find((item) => item.systemId === systemId);
    return {
      tenant: { id: tenant.id, name: tenant.name },
      members,
      eligible: allows(systemId),
      installation: installation
        ? { installationId: installation.installationId, status: installation.status }
        : null,
    };
  }

  async start(input: ExistingOnboardInput, actor: GovernanceActor): Promise<KyAppOnboardResult> {
    return this.options.store.withExecutionLock(
      `existing:${input.tenantId}:${input.systemId}`,
      async () => {
        await this.validateContact(input.tenantId, input.systemId, input.techContactUserId);
        const definition = await this.options.systems.getDefinition(input.systemId);
        if (
          !definition ||
          definition.status !== 'published' ||
          definition.publishedDigest !== input.expectedDigest
        )
          throw new KyAppSystemConflictError('系统发布版本已变化，请刷新后确认');
        const settings = await this.options.settings.get(input.systemId);
        if (settings.version !== input.expectedSettingsVersion)
          throw new KyAppSystemConflictError('系统接入配置已变化，请刷新后确认');
        const address = input.deployment ?? {
          baseUrl: connectionAddress(settings.settings.baseUrl, input.tenantId, input.systemId),
          origin: connectionAddress(settings.settings.origin, input.tenantId, input.systemId),
        };
        assertBaseUrl(address.baseUrl, this.options.config);
        assertOrigin(address.origin);
        const existing = (
          await this.options.systems.listInstallationsForTenant(input.tenantId)
        ).find((item) => item.systemId === input.systemId);
        const installationId = `${input.systemId.slice(0, 40)}-${createHash('sha256').update(`${input.systemId}:${input.tenantId}`).digest('hex').slice(0, 20)}`;
        if (existing && existing.installationId !== installationId)
          throw new KyAppSystemConflictError('该组织已接入此系统，请打开已有实例');
        const request: FrozenRequest = {
          mode: 'existing',
          systemId: input.systemId,
          tenantId: input.tenantId,
          techContactUserId: input.techContactUserId,
          installationId,
          ...address,
          digest: input.expectedDigest,
        };
        return this.run(request, actor);
      },
    );
  }

  async resume(executionId: string, actor: GovernanceActor) {
    const execution = await this.options.store.get(executionId);
    if (!execution || execution.request.mode !== 'existing')
      throw new KyAppSystemNotFoundError('已有组织接入记录不存在');
    return this.options.store.withExecutionLock(
      `existing:${execution.tenantId}:${execution.systemId}`,
      () => this.run(execution.request as FrozenRequest, actor),
    );
  }

  private requireTenant(tenantId: string) {
    const tenant = this.options.tenants.findByIdStrict(tenantId);
    if (!tenant || tenant.disabled)
      throw new KyAppInstallationError('请选择已有且有效的组织', 'invalid_tenant');
    return tenant;
  }

  private async validateContact(tenantId: string, systemId: string, userId: string) {
    this.requireTenant(tenantId);
    const allows = await installableScope(this.options.entitlementStore, tenantId);
    if (!allows(systemId))
      throw new KyAppInstallationError('组织权益未授权此业务系统，请先配置组织权益', 'forbidden');
    const user = this.options.users.findById(userId);
    const membership = await this.options.memberships.getMembership(tenantId, userId);
    if (!user || user.disabled || user.tenantId !== tenantId || membership?.status !== 'active')
      throw new KyAppInstallationError('技术联系人必须是所选组织的有效成员', 'invalid_contact');
  }

  private async run(request: FrozenRequest, actor: GovernanceActor): Promise<KyAppOnboardResult> {
    await this.validateContact(request.tenantId, request.systemId, request.techContactUserId);
    const definition = await this.options.systems.getDefinition(request.systemId);
    const version = await this.options.systems.getVersion(request.systemId, request.digest);
    if (definition?.status !== 'published' || version?.status !== 'published')
      throw new KyAppSystemConflictError('接入所需的已发布版本不可用');
    const { execution: initial } = await this.options.store.createOrResume({
      ...request,
      requestDigest: createHash('sha256').update(canonicalize(request)).digest('hex'),
      request,
    });
    let execution = initial;
    if (execution.status === 'completed') return { execution };
    const steps: KyAppOnboardStep[] = stepIds.map((id) => ({ id, status: 'pending' }));
    const result = { ...execution.result };
    let currentStep = 'existing_organization';
    const step = (
      id: string,
      status: KyAppOnboardStep['status'],
      detail?: Record<string, unknown>,
      code?: string,
    ) => {
      currentStep = id;
      steps[stepIds.indexOf(id)] = {
        id,
        status,
        ...(detail ? { detail } : {}),
        ...(code ? { code } : {}),
      };
    };
    const save = async (status: KyAppOnboardExecution['status'], code?: string) => {
      execution = await this.options.store.update({
        executionId: execution.executionId,
        status,
        currentStep,
        steps,
        result,
        lastErrorCode: code ?? null,
      });
      return execution;
    };
    const wait = async (id: string, code: string, detail?: Record<string, unknown>) => {
      step(id, 'waiting', detail, code);
      return { execution: await save('waiting_external', code) };
    };
    try {
      step('existing_organization', 'completed', { techContactUserId: request.techContactUserId });
      step('installation_credential', 'pending');
      let installation = await this.options.systems.getInstallation(request.installationId);
      if (
        installation &&
        (installation.status === 'deleted' ||
          installation.tenantId !== request.tenantId ||
          installation.systemId !== request.systemId ||
          installation.techContactUserId !== request.techContactUserId ||
          installation.baseUrl !== request.baseUrl ||
          installation.origin !== request.origin)
      )
        throw new KyAppSystemConflictError('已有安装实例与本次接入不一致，请打开实例详情');
      if (!installation) installation = await this.options.installations.create(request, actor);
      const domain = installation.domainVerificationToken
        ? {
            recordName: `_ky-app-verify.${new URL(installation.baseUrl).hostname}`,
            recordValue: installation.domainVerificationToken,
          }
        : undefined;
      result.domainVerification = domain ?? null;
      const credentials = await this.options.credentials.listMetadata(request.installationId);
      if (!credentials.some((item) => item.status === 'active')) {
        const pending = credentials.find((item) => item.status === 'pending_ack');
        if (pending)
          return wait('installation_credential', 'credential_ack_required', {
            credentialId: pending.credentialId,
          });
        const issued = await this.options.credentials.issue({
          installationId: request.installationId,
        });
        const waiting = await wait('installation_credential', 'credential_claim_required', {
          credentialId: issued.credentialId,
          ackDeadlineAt: issued.ackDeadlineAt,
        });
        return {
          ...waiting,
          claim: {
            path: `/api/app-contract/v1/installations/${request.installationId}/credentials/claim/${issued.ticket}`,
            credentialId: issued.credentialId,
            ticketExpiresAt: issued.ticketExpiresAt,
            ackDeadlineAt: issued.ackDeadlineAt,
          },
        };
      }
      step('installation_credential', 'completed');
      step('enable', 'pending');
      if (!installation.domainVerifiedAt) {
        if (
          !installation.domainVerificationToken ||
          !(
            await this.options.installations.probeDomainOwnership(
              new URL(installation.baseUrl).hostname,
              installation.domainVerificationToken,
            )
          ).verified
        )
          return wait('enable', 'domain_verification_required', domain);
        installation = (
          await this.options.installations.verifyDomain(request.installationId, actor)
        ).installation;
      }
      const runtime = await this.options.runtimeStore.get(request.installationId);
      if (runtime?.readyStatus !== 'ok' || runtime.manifestDigest !== request.digest)
        return wait('enable', 'ready_required', { expectedDigest: request.digest });
      if (installation.registeredDigest !== request.digest)
        installation = await this.options.installations.setRegisteredDigest({
          installationId: request.installationId,
          digest: request.digest,
          observedDigest: runtime.manifestDigest,
          expectedRegisteredDigest: installation.registeredDigest,
          actor,
        });
      if (installation.status !== 'enabled')
        await this.options.installations.setStatus({
          installationId: request.installationId,
          status: 'enabled',
          actor,
        });
      step('enable', 'completed');
      if (!(await this.options.getAssignmentConfigured?.(request.tenantId, request.installationId)))
        return wait('assignments', 'assignment_required');
      step('assignments', 'completed');
      const manifest = version.manifest as unknown as Manifest;
      const hasReadOnly = manifest.capabilities.some((item) => item.riskLevel === 'read_only');
      const { settings } = await this.options.settings.get(request.systemId);
      let diagnosticPassed = false;
      if (hasReadOnly) {
        if (!settings.diagnostic || !this.options.runSmoke)
          return wait('smoke', 'diagnostic_configuration_required');
        if (
          !manifest.capabilities.some(
            (item) =>
              item.id === settings.diagnostic!.readOnlyCapabilityId &&
              item.riskLevel === 'read_only',
          )
        )
          return wait('smoke', 'diagnostic_configuration_required');
        const members = await this.organizationOptions(request.systemId, request.tenantId);
        const admin = members.members.find((item) => item.isAdmin);
        if (!admin) return wait('smoke', 'organization_admin_required');
        result.adminUserId = admin.userId;
        const report = await this.options.runSmoke(request.installationId, {
          adminUserId: admin.userId,
          ...settings.diagnostic,
        });
        result.smoke = report;
        if (!report.passed)
          return wait('smoke', 'diagnostic_failed', report as unknown as Record<string, unknown>);
        diagnosticPassed = true;
      }
      step('smoke', 'completed', { diagnosticPassed, applicable: hasReadOnly });
      const checklist = {
        assignmentConfigured: true,
        publishedVersion: true,
        credentialAck: true,
        domainVerified: true,
        enabled: true,
        diagnosticPassed,
      };
      await this.options.store.upsertDelivery({ ...request, delivered: true, checklist });
      result.checklist = checklist;
      step('delivery_checklist', 'completed', checklist);
      return { execution: await save('completed') };
    } catch (error) {
      step(currentStep, 'failed');
      await save('failed', 'connection_failed');
      throw error;
    }
  }
}
