import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('./KyAppCredentialClaimPage', () => ({
  KyAppCredentialClaimPage: ({ installationId }: { installationId: string }) => (
    <p>{window.location.hash === '' ? installationId : 'fragment 未清除'}</p>
  ),
}));
import { KyAppCredentialClaimEntry } from './KyAppCredentialClaimEntry';
it('StrictMode 下清除旧版票据 fragment，再进入纯 V2 自动授权页面', async () => {
  window.history.replaceState(
    null,
    '',
    '/ky-app/credential-claim/demo#ticket=one-time-test-ticket',
  );
  render(
    <StrictMode>
      <KyAppCredentialClaimEntry installationId="demo" />
    </StrictMode>,
  );
  expect(window.location.hash).toBe('');
  expect(await screen.findByText('demo')).toBeTruthy();
  expect(document.body.textContent).not.toContain('one-time-test-ticket');
  window.history.replaceState(null, '', '/');
});
