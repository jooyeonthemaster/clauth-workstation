import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsTaskXml, macPlist, vbsLauncher, xml } from '../src/services.mjs';

function decode(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

test('Windows service is current-user least-privilege, hidden, and preserves an escaped launcher path', () => {
  const launcher = String.raw`C:\Users\Test & Co\한글\service.vbs`;
  const sid = 'S-1-5-21-111-222-333-1001';
  const output = windowsTaskXml({ node: 'IGNORED_SECRET_SENTINEL', cliPath: 'IGNORED_SECRET_SENTINEL', launcher, sid });
  assert.match(output, /<UserId>S-1-5-21-111-222-333-1001<\/UserId>/);
  assert.match(output, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(output, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(output, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(output, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(output, /<Command>wscript\.exe<\/Command>/);
  const args = decode(/<Arguments>(.*?)<\/Arguments>/.exec(output)[1]);
  assert.equal(args, `//B //NoLogo "${launcher}"`);
  assert.doesNotMatch(output, /IGNORED_SECRET_SENTINEL|<Password>|HighestAvailable|<LogonType>Password/);
});

test('VBScript launcher quotes executable and arguments and propagates the supervised exit code', () => {
  const executable = String.raw`C:\Program Files\nodejs\node.exe`;
  const script = String.raw`C:\Users\Test & Co\한글\src\cli.mjs`;
  const output = vbsLauncher(executable, script, ['serve', '--port', '47822']);
  const vbString = /code = sh\.Run\("((?:[^\"]|\"\")*)", 0, True\)/.exec(output);
  assert.ok(vbString, 'launcher hides its window and waits for the child');
  const command = vbString[1].replaceAll('""', '"');
  assert.equal(command, `"${executable}" "${script}" "serve" "--port" "47822"`);
  assert.match(output, /WScript\.Quit code/);
  assert.doesNotMatch(output, /cmd\.exe|powershell|ExecutionPolicy|FIXTURE_TOKEN/);
});

test('macOS launch agent keeps absolute paths as individual escaped arguments and carries the selected port', () => {
  const node = '/Users/Test & Co/node/bin/node';
  const cliPath = '/Users/한글/owner\'s <workspace>/src/cli.mjs';
  const stateDir = '/Users/Test & Co/.clauth-workstation';
  const output = macPlist({ node, cliPath, stateDir, port: 47822 });
  const args = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(output)[1];
  const values = [...args.matchAll(/<string>(.*?)<\/string>/gs)].map(match => decode(match[1]));
  assert.deepEqual(values, [node, cliPath, 'serve', '--port', '47822']);
  assert.match(output, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(output, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(output, /<key>CLAUTH_NO_UPDATE<\/key><string>1<\/string>/);
  assert.match(output, /<key>CLAUTH_NO_COMPLETIONS<\/key><string>1<\/string>/);
  assert.doesNotMatch(output, /<key>UserName|<key>GroupName|accessToken|refreshToken|api_key|GEMINI_API_KEY/);
  assert.equal(output.includes(node), false, 'raw ampersand must be XML-escaped');
  assert.equal(output.includes(cliPath), false, 'raw bracket/apostrophe path must be XML-escaped');
});

test('XML escaping is lossless and rejects no valid path characters by accidental interpolation', () => {
  const input = `한글 & <angle> "quote" 'apostrophe' $HOME \`literal\``;
  const output = xml(input);
  assert.equal(decode(output), input);
  assert.equal(output.includes('<angle>'), false);
  assert.equal(output.includes('& '), false);
});
