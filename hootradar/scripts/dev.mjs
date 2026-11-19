// Runs the API (tsx watch) and the Vite dev server side by side.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', 'web'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
