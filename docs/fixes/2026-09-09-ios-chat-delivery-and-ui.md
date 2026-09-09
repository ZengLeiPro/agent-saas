# iOS chat delivery and business-step detail repair

## Scope and evidence

Baseline: `9bfd1a56ec561f63570a8e58f7cd4f0e13f5c262` (main).
The reported symptom is a message remaining pending and eventually failing. This change addresses source-proven transport races; it is not a claim that the reporter's installed iOS binary or production logs were reproduced locally.

Source evidence:

- `shared/src/lib/wsClient.ts`: connection waiters were installed separately for each call before asynchronous credential reads completed. Concurrent calls could overwrite the resolver before a native socket even existed.
- `forceReconnect()` cleared the connection deadline and resolver/rejector without settling or transferring existing waiters. `mobile/src/hooks/useWsLifecycle.ts` can invoke it during foreground/network recovery, including during an in-flight connection.
- A native `WebSocket.send()` exception escaped the boolean send contract. A throwing state or message subscriber could also prevent later subscribers, including chat receipt handlers, from running.
- `mobile/src/components/chat/blocks/BusinessStepBlock.tsx` rendered entire result details/cards/tables inline; the section header was not a detail-sheet entry point.
- The existing business-step sheet used half height. Generic full height was a fixed 90% of screen height, not a top-safe-area boundary. It lacked an explicit close control and a flex-constrained body for long scrollable content.

## Transport behavior after the change

1. One pending connection is installed synchronously before SecureStore reads. All connect/acquire/send callers share it.
2. Foreground/network socket replacement retains pending waiters and their original deadline. It cannot prolong a submission indefinitely by restarting that deadline.
3. Each asynchronous credential read and socket callback is fenced by socket attempt and identity generation. Old reads cannot recreate a socket after logout/account switch.
4. Connection timeout closes the abandoned socket and settles the waiters. Native send exceptions return false and initiate transport recovery; chat payloads are never automatically replayed.
5. Sending across an identity boundary or while lifecycle transport is suspended fails closed. The established auth-first-frame, trusted-origin policy, authEpoch/generation checks, canonical submission DTO, and shared sequence recovery reducer remain in use.
6. Subscribers are isolated so a broken screen or telemetry callback cannot swallow another subscriber's acknowledgement.
7. Failed acquire rolls back its reference count.

`send() === true` still means transport write, not server acceptance. Message acknowledgement and idempotency remain server-authoritative. Do not replace this with optimistic success, disable authentication, or add an uncontrolled HTTP retry.

## Conversation and detail layout

- Chat shows a compact step title/status, a bounded outcome summary, and an explicit detail affordance instead of full result tables.
- Plan rows, timeline sections, and isolated step events open the bottom detail sheet.
- The sheet starts immediately below the top safe area with a small gap. Only the top corners are rounded; the surface reaches the bottom edge and home-indicator padding is inside it.
- A drag handle, 44-point close target, backdrop dismissal, accessibility escape, and Android back dismissal are available. Dismiss gestures belong to the header, not the scrollable results/tables.
- Fixed header, flex-constrained scrolling, horizontal step selection from the plan, result/deliverables first, collapsible process/evidence, and existing canonical card/table components align with Web's information structure.
- Pending approval/question controls and external-system write records remain visible in the conversation. The original render callback and RawPresentationGate continue to control raw-data visibility.
- Reopen/close animation uses progress and a generation guard, rather than depending on another layout event; stale exit completion cannot hide a newly reopened sheet.

## Validation

No local tests, dependency installation, builds, simulator runs, or device runs were performed, as requested. Added regression tests are intended to run in GitHub Actions together with the repository's existing checks:

- Shared transport: concurrent asynchronous credentials, reconnect during credentials/upgrade, deadline preservation, closed native socket, subscriber exception isolation, identity boundary, background suspension, and failed acquire cleanup.
- Mobile layout: safe-area geometry for notched/non-notched/landscape devices, full/half/auto sizing, and zero-height transient layout.
- Mobile business details: stable deduplication, result/process/deliverable partition, visible approval/write controls, and component wiring/accessibility guards.

The authoritative CI outcome is the latest PR head's GitHub check runs, not this document. A green PR does not mean an installed TestFlight binary has changed.

## Device/release acceptance (still requires the normal release process)

After merge and an iOS build/update through the existing release process, verify on a real phone:

1. New and existing conversations: send text, receive acceptance, stream a response, send the next message, and confirm history contains one copy.
2. Foreground/background and Wi-Fi/cellular transitions: send during recovery, confirm bounded failure/recovery, and retry using the original message identity without duplicate execution.
3. Image/file/voice submissions and approval/question responses still follow their canonical IDs and security gates.
4. Open long business details while the keyboard is visible; inspect portrait/landscape, top safe area, bottom home indicator, long text, comparison-table horizontal scrolling, and step tabs.
5. Close by button, backdrop, header drag and accessibility escape; reopen quickly during exit animation. Check large text and reduced motion, and both light/dark themes.
6. Confirm completed result summaries stay compact while approvals and external writes remain discoverable.

This PR does not merge itself, deploy production, or publish a TestFlight build. Those actions are outside the requested PR/CI scope.
