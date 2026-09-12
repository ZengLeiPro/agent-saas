/** Lock order is publication fence -> credential lock. The callback must not acquire the publication fence again. */
export interface SubscriptionCredentialRotationTransaction {
  <T>(credentialRef: string, rotate: () => Promise<T>): Promise<T>;
}
