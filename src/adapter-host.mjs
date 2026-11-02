import { pathToFileURL } from 'node:url';
import { assert, load, save } from './common.mjs';
const [modulePath, input, output] = process.argv.slice(2);
try {
  const adapter = await import(pathToFileURL(modulePath).href);
  const request = await load(input);
  assert(['evaluate', 'propose'].includes(request.method), 'Unknown adapter method');
  assert(typeof adapter[request.method] === 'function', `Adapter missing ${request.method}`);
  await save(output, await adapter[request.method](request));
} catch (error) {
  console.error(`Adapter failed: ${error.message}`);
  process.exitCode = 1;
}
