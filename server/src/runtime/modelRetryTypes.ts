export type ModelRetryReason =
  | 'transient_network_error'
  | 'transient_http_error'
  | 'transient_stream_interrupt'
  | 'stream_guard_recovery'
  | 'transient_provider_error'
  | 'previous_response_not_found'
  | 'invalid_encrypted_content';

export type ModelRetryBlockedReason =
  | 'aborted'
  | 'permanent_error'
  | 'irreversible_output_delivered'
  | 'retry_budget_exhausted';
