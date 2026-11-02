import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const name = 'ops-ga-exposure-observer';
export const inject = ['sandboxPolicy', 'sessions'];
// Runs at the actual provider boundary, not a guessed registry/dump projection.
// Never records messages, credentials or tool arguments and never mutates requests.
export function apply(ctx, config) {
  let sequence = 0;
  ctx.on('llm/stream', (request, next) => {
    const tools = request.tools ?? [];
    if (!request.sessionId || !Array.isArray(tools)) throw new Error('Exposure probe requires session-scoped wire tools');
    const snapshot = { version: 1, sequence: ++sequence, sessionId: request.sessionId,
      provider: request.provider, model: request.model, permission: ctx.get('sandboxPolicy').resolve({ session: ctx.get('sessions')?.get(request.sessionId) }).mode,
      schemaDigest: digest(tools), schemaBytes: Buffer.byteLength(JSON.stringify(tools)), tools,
      payloadDigest: config.payloadDigest };
    const expected = config.expected;
    if (!expected || snapshot.provider !== expected.provider || snapshot.model !== expected.model || snapshot.permission !== expected.permission) throw new Error('Wire route/permission mismatch before provider dispatch');
    const names = tools.map(t => t.name);
    if ((expected.requiredTools ?? []).some(n => !names.includes(n)) || (expected.forbiddenTools ?? []).some(n => names.includes(n))) throw new Error('Wire tool exposure mismatch before provider dispatch');
    if (expected.exactTools && JSON.stringify([...names].sort()) !== JSON.stringify([...expected.exactTools].sort())) throw new Error('Unexpected wire tool set before provider dispatch');
    appendFileSync(config.output, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
    return next();
  }, { global: true, prepend: true });
}
