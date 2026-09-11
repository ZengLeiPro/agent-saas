/** One listener owns the handoff exchange, including timeout/error cleanup. */
export function collectWorkerHandoff(ws, { first = [], triggerHandoff, timeoutMs = 60_000 }) {
  const events = [...first];
  let started = false;
  let handoff;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', fail);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => fail(new Error('websocket closed before worker handoff completed'));
    const consider = ({ data = {} }) => {
      if (data.type === 'error' || (data.type === 'done' && data.error)) {
        throw new Error('worker handoff emitted a runtime error');
      }
      if (!started && data.type === 'tool_input') {
        started = true;
        handoff = Promise.resolve().then(triggerHandoff);
        void handoff.catch(fail);
      }
      if (data.type === 'done') {
        if (!started) throw new Error('run completed without an in-flight handoff');
        cleanup();
        void handoff.then(() => resolve(events), reject);
      }
    };
    const onMessage = (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        events.push(envelope);
        consider(envelope);
      } catch (error) {
        fail(error);
      }
    };
    const timer = setTimeout(
      () => fail(new Error('worker handoff timed out before terminal evidence')),
      timeoutMs,
    );
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', fail);
    try {
      for (const envelope of first) consider(envelope);
    } catch (error) {
      fail(error);
    }
  });
}
