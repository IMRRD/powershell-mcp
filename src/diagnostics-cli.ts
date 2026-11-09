/** Local operator entry point. A bounded JSON request on stdin; no MCP or public endpoint. */
import { RestrictedDiagnosticsStore } from './diagnostics-store.js';
import { DIAGNOSTICS_POLICY } from './diagnostics-schema.js';
let text = '';
process.stdin.setEncoding('utf8');
try {
  for await (const part of process.stdin) {
    text += part.toString('utf8');
    if (Buffer.byteLength(text) > 4096) throw Error();
  }
  const request = JSON.parse(text);
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.directory !== 'string' || typeof request.installation !== 'string') throw Error();
  const store = new RestrictedDiagnosticsStore(request.directory, request.installation);
  let fields = ['operation', 'directory', 'installation'];
  let reply;
  switch (request.operation) {
    case 'consent': fields.push('policy'); break;
    case 'read': if ('limit' in request) fields.push('limit'); if ('after' in request) fields.push('after'); break;
    case 'disable': case 'revoke': break;
    default: throw Error();
  }
  if (Object.keys(request).sort().join(',') !== fields.sort().join(',')) throw Error();
  if (request.operation === 'consent') {
    if (request.policy !== DIAGNOSTICS_POLICY) throw Error();
    reply = await store.consent(request.policy);
  } else if (request.operation === 'read') reply = await store.read(request.limit, request.after);
  else if (request.operation === 'disable') reply = await store.disable();
  else reply = await store.revoke();
  process.stdout.write(JSON.stringify(reply) + '\n');
  if (reply.status !== 'ok') process.exitCode = 1;
} catch { process.stdout.write('{"status":"invalid"}\n'); process.exitCode = 1; }
