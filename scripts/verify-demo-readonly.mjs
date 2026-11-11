#!/usr/bin/env node
// One uninterrupted, provider-neutral, read-only demo security gate.
// No credentials, external API requests, account orders, or secrets are used.
import { spawnSync } from 'node:child_process';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const phases=[
  {
    title:'Syntax and entrypoint safety',
    commands:[
      ['--check','monitor/readonly-transport.mjs'],
      ['--check','monitor/demo-account-validation.mjs'],
      ['--check','monitor/demo-account-reader.mjs'],
      ['--check','monitor/demo-account-checkpoint-store.mjs'],
      ['--check','monitor/persisted-demo-account-reader.mjs'],
    ],
  },
  {
    title:'Read-only HTTP transport, payload validation and replay prevention',
    commands:[['--test','--test-concurrency=1',
      'tests/readonly-transport.test.mjs',
      'tests/demo-account-validation.test.mjs',
      'tests/demo-account-reader.test.mjs']],
  },
  {
    title:'Checkpoint integrity, atomic writes, locks and killed child process',
    commands:[['--test','--test-concurrency=1',
      'tests/demo-account-checkpoint-store.test.mjs',
      'tests/demo-account-checkpoint-crash.test.mjs']],
  },
  {
    title:'Persisted reader, process restart and shared-file integration',
    commands:[['--test','--test-concurrency=1',
      'tests/persisted-demo-account-reader.test.mjs',
      'tests/persisted-demo-account-e2e.test.mjs']],
  },
];

let checks=0;
const started=Date.now();
for(let i=0;i<phases.length;i++) {
  const phase=phases[i];
  process.stdout.write(`\n[demo-readonly ${i+1}/${phases.length}] ${phase.title}\n`);
  for(const args of phase.commands) {
    const result=spawnSync(process.execPath,args,{
      cwd:projectRoot,
      stdio:'inherit',
      windowsHide:true,
      timeout:120000,
    });
    if(result.error||result.signal||result.status!==0) {
      process.stderr.write(`\nDEMO SECURITY GATE FAILED at phase ${i+1}: ${phase.title}\n`);
      if(result.error) process.stderr.write(`${result.error.message}\n`);
      process.exitCode=1;
      break;
    }
    checks++;
  }
  if(process.exitCode) break;
}
if(!process.exitCode) {
  process.stdout.write(`\nDEMO SECURITY GATE PASS: ${phases.length} phases, ${checks} commands, ${Date.now()-started} ms.\n`);
  process.stdout.write('Only synthetic fixtures passed. Live UpScale account access: NO-GO. Order execution: disabled.\n');
}
