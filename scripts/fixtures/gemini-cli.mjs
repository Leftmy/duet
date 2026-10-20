// Deterministic NDJSON fixture for Gemini CLI stream-json tests; never contacts a model.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const nativeId = at < 0 ? 'native-gemini-session' : args[at + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');

fs.appendFileSync(
  process.env.GEMINI_FIXTURE_LOG,
  JSON.stringify({ args, api: process.env.GEMINI_API_KEY ?? null, gca: process.env.GOOGLE_GENAI_USE_GCA ?? null }) + '\n',
);

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { rawInput += chunk; });
process.stdin.on('end', () => {
  const prompt = rawInput.trim();
  fs.appendFileSync(process.env.GEMINI_FIXTURE_LOG, JSON.stringify({ prompt }) + '\n');
  emit({ type: 'init', session_id: nativeId, model: 'gemini-2.5-pro' });
  emit({ type: 'message', role: 'user', content: prompt });
  if (prompt === '__malformed__') {
    process.stdout.write('invalid json\n');
    return;
  }
  if (prompt === '__exit__') {
    process.stderr.write('fixture failure');
    process.exit(2);
  }
  if (prompt === '__hang__') {
    setInterval(() => {}, 1000);
    return;
  }
  const memory = path.join(process.cwd(), 'memory.txt');
  const response = prompt === '__recall__' ? fs.readFileSync(memory, 'utf8') : prompt;
  fs.writeFileSync(memory, response);
  emit({ type: 'tool_use', tool_name: 'read_file', tool_id: 'call-1', parameters: { file_path: memory } });
  emit({ type: 'tool_result', tool_id: 'call-1', status: 'success', output: 'fixture' });
  emit({ type: 'message', role: 'assistant', content: response.slice(0, 2), delta: true });
  emit({ type: 'message', role: 'assistant', content: response.slice(2), delta: true });
  emit({ type: 'result', status: 'success', stats: { total_tokens: 10 } });
});
