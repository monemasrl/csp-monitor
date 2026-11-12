import { hashPassword } from '../src/auth/password.js';

function readHidden(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    process.stderr.write('Password: ');
    return new Promise((resolve) => {
      let pw = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.on('data', function onData(chunk: string) {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            process.stderr.write('\n');
            return resolve(pw);
          }
          if (ch === '\u0003') {
            stdin.setRawMode(false);
            process.stderr.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1);
          else pw += ch;
        }
      });
    });
  }
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => (data += c));
    stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

const pw = await readHidden();
if (!pw) {
  console.error('Empty password');
  process.exit(1);
}
console.log(hashPassword(pw));
