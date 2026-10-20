// A deterministic NDJSON peer for the adapter tests; never contacts a model.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const at = args.indexOf('--conversation');
const nativeId = at < 0 ? 'native-test-session' : args[at + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
fs.appendFileSync(process.env.AGY_FIXTURE_LOG, JSON.stringify({ args, api: process.env.GEMINI_API_KEY ?? null }) + '\n');
emit({ event: 'init', conversation_id: nativeId });
const input = createInterface({ input: process.stdin });
let step = 0;
input.on('line', (line) => {
  const prompt = JSON.parse(line).message.content;
  fs.appendFileSync(process.env.AGY_FIXTURE_LOG, JSON.stringify({ prompt }) + '\n');
  if (prompt === '__malformed__') return process.stdout.write('invalid json\n');
  if (prompt === '__exit__') { process.stderr.write('fixture failure'); process.exit(2); }
  if (prompt === '__hang__') return;
  const memory = path.join(process.cwd(), 'memory.txt');
  const response = prompt === '__recall__' ? fs.readFileSync(memory, 'utf8') : prompt;
  fs.writeFileSync(memory, response);
  emit({ event: 'step_update', step_update: { step_index: step++, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: memory }, output: 'fixture' } } });
  const id = step++;
  emit({ event: 'step_update', step_update: { step_index: id, state: 'ACTIVE', step_type: 'agent_response', text_delta: response.slice(0, 2) } });
  emit({ event: 'step_update', step_update: { step_index: id, state: 'DONE', step_type: 'agent_response', text_delta: response.slice(2) } });
  emit({ event: 'result', result: { conversation_id: nativeId, status: 'SUCCESS', response } });
});
