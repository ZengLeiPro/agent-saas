import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseAllDocuments } from 'yaml';

const manifestPath = new URL(
  '../../acs-orchestrator/k8s/ownership-journal-rbac.yaml',
  import.meta.url,
);
const bootstrapPath = new URL('../bootstrap-acs-ownership-journal.sh', import.meta.url);

test('ACS ownership journal bootstrap grants only exact read/write access', () => {
  const resources = parseAllDocuments(readFileSync(manifestPath, 'utf8')).map((document) =>
    document.toJSON(),
  );
  const role = resources.find((resource) => resource.kind === 'Role');
  const binding = resources.find((resource) => resource.kind === 'RoleBinding');

  assert.equal(resources.some((resource) => resource.kind === 'ConfigMap'), false);
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

test('ACS ownership journal bootstrap never reapplies an empty journal over live records', () => {
  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  assert.match(bootstrap, /get configmap "\$JOURNAL_NAME" --ignore-not-found -o name/u);
  assert.match(bootstrap, /if \[ -z "\$existing" \]; then[\s\S]*create configmap/u);
  assert.doesNotMatch(bootstrap, /apply[^\n]*ConfigMap|replace[^\n]*configmap/u);
});
