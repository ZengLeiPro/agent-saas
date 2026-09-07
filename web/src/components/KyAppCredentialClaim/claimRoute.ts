export function credentialClaimInstallation(pathname: string): string | null {
  const match = /^\/ky-app\/credential-claim\/([A-Za-z0-9][A-Za-z0-9_.-]{2,63})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}
export function credentialClaimUrl(installationId: string, ticket: string): string {
  return `${window.location.origin}/ky-app/credential-claim/${encodeURIComponent(installationId)}#ticket=${encodeURIComponent(ticket)}`;
}
