#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { checkSubmission } from '../src/submission.mjs';
const file = process.argv[2];
if (!file) { console.error('Usage: node bin/validate-submission.mjs external-pr/<id>/submission.json'); process.exit(2); }
try { console.log(JSON.stringify(await checkSubmission(file), null, 2)); }
catch (e) { console.error(`submission: ${e.message}`); process.exit(1); }
