import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseAllDocuments } from 'yaml';

const manifestPath = new URL(
  '../../acs-orchestrator/k8s/ownership-journal-rbac.yaml',
  import.meta.url,
);

test('ACS ownership journal bootstrap is pre-created and grants only exact read/write access', () => {
  const resources = parseAllDocuments(readFileSync(manifestPath, 'utf8')).map((document) =>
    document.toJSON(),
  );
  const journal = resources.find((resource) => resource.kind === 'ConfigMap');
  const role = resources.find((resource) => resource.kind === 'Role');
  const binding = resources.find((resource) => resource.kind === 'RoleBinding');

  assert.deepEqual(JSON.parse(journal.data['journal.json']), { protocolVersion: 1, records: [] });
  assert.equal(journal.metadata.name, 'acs-operation-ownership-v1');
  assert.deepEqual(role.rules, [
    {
      apiGroups: [''],
      resources: ['configmaps'],
      resourceNames: ['acs-operation-ownership-v1'],
      verbs: ['get', 'update'],
    },
  ]);
  assert.deepEqual(binding.subjects, [
    {
      kind: 'ServiceAccount',
      name: 'agent-saas-acs-orchestrator',
      namespace: 'agent-saas-coding',
    },
  ]);
  assert.deepEqual(binding.roleRef, {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'Role',
    name: 'agent-saas-acs-orchestrator-ownership-journal',
  });
});
