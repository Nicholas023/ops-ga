#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { packSessions, digest } from '../src/submission.mjs';
const [directory, out, ...files] = process.argv.slice(2);
try {
  if (!directory || !out || !files.length) throw new Error('Usage: node bin/pack-sessions.mjs <reviewed-dir> <out.zip> redaction.json sessions/a.jsonl ...');
  const archive = await packSessions(directory, files);
  await writeFile(out, archive, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ out, sha256: digest(archive), bytes: archive.length, note: 'Private until human redaction/redistribution review; never upload automatically' }));
} catch (e) { console.error(e.message); process.exitCode = 1; }
