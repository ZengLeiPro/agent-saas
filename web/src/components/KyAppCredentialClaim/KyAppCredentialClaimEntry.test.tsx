import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('./KyAppCredentialClaimPage', () => ({
  KyAppCredentialClaimPage: ({ initialTicket }: { initialTicket: string }) => (
    <p>{window.location.hash === '' ? initialTicket : 'fragment 未清除'}</p>
  ),
}));
import { KyAppCredentialClaimEntry } from './KyAppCredentialClaimEntry';
it('StrictMode 下先清除 fragment，再将内存票据传入异步领取页面', async () => {
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
  expect(await screen.findByText('one-time-test-ticket')).toBeTruthy();
  window.history.replaceState(null, '', '/');
});
