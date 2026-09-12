import assert from 'node:assert/strict';
import {
  assertRequest,
  assertStep,
  REQUEST_ENVIRONMENT,
  REQUEST_TASK,
  STEP_TASK,
  requireAutomatic,
  seal,
} from './automatic-release-contract.mjs';

/** GitHub Deployment payloads are immutable reservations, not a claim that Production is healthy. */
export class AutomaticLedger {
  constructor(client) {
    this.client = client;
  }
  async records(task, parentRunId) {
    return (
      await this.client.pages(`deployments?environment=${REQUEST_ENVIRONMENT}&task=${task}`)
    ).filter((value) => value.payload?.parentRunId === String(parentRunId));
  }
  async create(payload, task) {
    const record = await this.client.api('deployments', {
      ref: payload.engineSha,
      task,
      environment: REQUEST_ENVIRONMENT,
      auto_merge: false,
      required_contexts: [],
      production_environment: false,
      transient_environment: true,
      description: `Automatic release ${payload.parentRunId}${payload.stage ? ` / ${payload.stage}` : ''}`,
      payload,
    });
    requireAutomatic(
      Number.isSafeInteger(record?.id) && record.id > 0,
      'reservation_unknown',
      '调度登记结果未知，已停止；不会重发生产请求。',
    );
    const readback = await this.client.api(`deployments/${record.id}`);
    assert.deepEqual(readback.payload, payload, 'Request reservation readback mismatch');
    return readback;
  }
  async request(run, create, repository) {
    const records = await this.records(REQUEST_TASK, run.id);
    requireAutomatic(records.length <= 1, 'duplicate_request', '同一请求存在冲突的持久化记录。');
    if (records.length === 1) {
      assertRequest(records[0], run, repository);
      return records[0];
    }
    requireAutomatic(
      run.run_attempt === 1,
      'lost_request',
      '重跑缺少原始目标记录，不能重新选择目标。请核查原请求。',
    );
    const record = await this.create(await create(), REQUEST_TASK);
    assertRequest(record, run, repository);
    return record;
  }
  async step(requestRecord, runAttempt, stage, workflow, sourceSha, inputs) {
    const request = requestRecord.payload;
    const records = (await this.records(STEP_TASK, request.parentRunId)).filter(
      (record) => record.payload.stage === stage,
    );
    requireAutomatic(
      records.length <= 1,
      'duplicate_reservation',
      '同一阶段存在多个调度登记，不能重复派发。',
    );
    if (records.length === 1) {
      const value = assertStep(records[0], request);
      assert.equal(value.workflow, workflow);
      assert.equal(value.sourceSha, sourceSha);
      assert.deepEqual(value.inputs, inputs);
      return { record: records[0], fresh: false };
    }
    const payload = seal({
      schemaVersion: 1,
      kind: 'automatic-release-step',
      repository: request.repository,
      requestId: String(requestRecord.id),
      requestDigest: request.digest,
      parentRunId: request.parentRunId,
      parentRunAttempt: runAttempt,
      engineSha: request.engineSha,
      key: `auto:${request.parentRunId}:${stage}`,
      stage,
      workflow,
      sourceSha,
      inputs,
    });
    const record = await this.create(payload, STEP_TASK);
    assertStep(record, request);
    return { record, fresh: true };
  }
  async status(record, state, description, runId) {
    return this.client.api(`deployments/${record.id}/statuses`, {
      state,
      environment: REQUEST_ENVIRONMENT,
      auto_inactive: false,
      description: description.slice(0, 140),
      log_url: `https://github.com/${this.client.repository}/actions/runs/${runId}`,
    });
  }
}
