// SDK simulé : enregistre les messages utilisateur reçus et répond par un tour (assistant + result) par message.
export function makeFakeQuery() {
  const calls = [];
  const queryFn = ({ prompt, options }) => {
    const call = { options, inputs: [], closed: false };
    calls.push(call);
    const it = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: `s${calls.length}` };
        for await (const m of prompt) {
          const text = m.message.content;
          call.inputs.push(text);
          const reply = /\[Rotation\]/.test(text) ? `RESUME-${calls.length}` : `ok:${text.slice(0, 20)}`;
          yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }], usage: {} } };
          yield { type: 'result', subtype: 'success', result: reply, duration_ms: 1 };
        }
      },
      close() { call.closed = true; },
    };
    return it;
  };
  return { queryFn, calls };
}
export const until = async (fn, ms = 5000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout until()');
};
