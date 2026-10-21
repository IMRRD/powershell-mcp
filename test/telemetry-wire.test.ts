import { describe, it, expect } from 'vitest';
import { validQueuedEvent, readAcknowledgement } from '../src/telemetry-wire.js';
const eventId = '12345678-1234-4234-8234-123456789abc';
const payload = { schemaVersion: 1, eventId, event: 'startup', version: '0.6.0', hostId: eventId, os: 'win32', ts: '2026-10-21T00:00:00.000Z' };
describe('telemetry wire boundaries', () => {
  it('accepts only the complete allowlisted event', () => {
    expect(validQueuedEvent(payload, eventId)).toBe(true);
    expect(validQueuedEvent({ ...payload, command: 'private' }, eventId)).toBe(false);
    expect(validQueuedEvent({ ...payload, event: 'tool_counts', counts: { arbitrary: 1 } }, eventId)).toBe(false);
    expect(validQueuedEvent({ ...payload, event: 'tool_counts', counts: { run_program: 1 } }, eventId)).toBe(true);
    expect(validQueuedEvent(payload, 'wrong')).toBe(false);
    expect(validQueuedEvent({ ...payload, ts: '2026-02-30T00:00:00.000Z' }, eventId)).toBe(false);
  });
  it('requires matching bounded acknowledgements', async () => {
    await expect(readAcknowledgement(new Response(JSON.stringify({ ok: true, eventId }), { status: 202 }), eventId)).resolves.toBeUndefined();
    await expect(readAcknowledgement(new Response(JSON.stringify({ ok: true, eventId: 'wrong' }), { status: 202 }), eventId)).rejects.toThrow();
    await expect(readAcknowledgement(new Response(' '.repeat(1025), { status: 202 }), eventId)).rejects.toThrow();
    await expect(readAcknowledgement(new Response('{}', { status: 500 }), eventId)).rejects.toThrow();
  });
});
