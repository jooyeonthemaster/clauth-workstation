import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { REPO, atomicWrite } from './config.mjs';

const cli = path.join(REPO, 'src', 'cli.mjs');
export const SERVICE = 'ClauthWorkstation';
export const LABEL = 'local.clauth.workstation';
export function xml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function run(exe, args, { allowFailure = false } = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (!allowFailure && (r.error || r.status !== 0)) throw new Error(`${path.basename(exe)} failed; service setup did not complete`);
  return r;
}

export function legacyTasks(platform = process.platform) {
  if (platform !== 'win32') return [];
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like 'clauth-*' -and $_.State -ne 'Disabled' } | Select-Object -ExpandProperty TaskName) | ConvertTo-Json -Compress"], { allowFailure: true });
  if (r.error || r.status !== 0) throw new Error('Could not inspect existing Windows automation; refusing to start competing services');
  try { const parsed = JSON.parse(r.stdout.trim() || '[]'); return Array.isArray(parsed) ? parsed : [parsed]; }
  catch { throw new Error('Could not read existing task state'); }
}

export function windowsTaskXml({ node, cliPath, launcher, sid }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Clauth workstation monitor and native engine supervision</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="User"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>wscript.exe</Command><Arguments>//B //NoLogo &quot;${xml(launcher)}&quot;</Arguments></Exec></Actions>
</Task>`;
}

export function macPlist({ node, cliPath, stateDir, port = 47821 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cliPath)}</string><string>serve</string><string>--port</string><string>${xml(port)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>CLAUTH_NO_UPDATE</key><string>1</string><key>CLAUTH_NO_COMPLETIONS</key><string>1</string><key>PATH</key><string>${xml([path.dirname(node), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'))}</string></dict>
<key>StandardOutPath</key><string>${xml(path.join(stateDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'service-error.log'))}</string>
</dict></plist>`;
}

export function vbsLauncher(node, script, args) {
  const command = [node, script, ...args].map(v => `"${v}"`).join(' ');
  return `Option Explicit\nDim sh, code\nSet sh = CreateObject("WScript.Shell")\ncode = sh.Run("${command.replaceAll('"', '""')}", 0, True)\nWScript.Quit code\n`;
}

export function installLauncher(config) {
  if (process.platform === 'win32') {
    const launcher = path.join(config.stateDir, 'open-monitor.vbs');
    atomicWrite(launcher, vbsLauncher(process.execPath, cli, ['open', '--port', String(config.port)]));
    // Resolve redirected/OneDrive desktops through the OS rather than guessing.
    const script = path.join(config.stateDir, 'create-shortcut.ps1');
    atomicWrite(script, `param([string]$Target)\n$w = New-Object -ComObject WScript.Shell\n$p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Clauth Workstation.lnk'\n$s = $w.CreateShortcut($p)\n$s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'\n$s.Arguments = '//B //NoLogo "' + $Target + '"'\n$s.WindowStyle = 7\n$s.Description = 'Clauth account monitor'\n$s.Save()\n`);
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, launcher]);
    return launcher;
  }
  if (process.platform === 'darwin') {
    const app = path.join(config.stateDir, 'Clauth Monitor.app');
    atomicWrite(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>launcher</string><key>CFBundleIdentifier</key><string>local.clauth.monitor</string><key>CFBundleName</key><string>Clauth Monitor</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
    const exe = path.join(app, 'Contents', 'MacOS', 'launcher');
    atomicWrite(exe, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} open --port ${config.port}\n`, 0o700);
    return app;
  }
  throw new Error('Desktop launcher supports Windows and macOS');
}

export function installService(config) {
  if (legacyTasks().length) throw new Error('Existing clauth scheduled tasks are active. Keep this workstation read-only until migration.');
  if (process.platform === 'win32') {
    const sid = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']).stdout.trim();
    if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Could not resolve Windows user SID');
    const launcher = path.join(config.stateDir, 'service.vbs');
    atomicWrite(launcher, vbsLauncher(process.execPath, cli, ['serve', '--port', String(config.port)]));
    const taskFile = path.join(config.stateDir, 'service.xml');
    atomicWrite(taskFile, Buffer.from('\uFEFF' + windowsTaskXml({ node: process.execPath, cliPath: cli, launcher, sid }), 'utf16le'));
    run('schtasks.exe', ['/Create', '/TN', SERVICE, '/XML', taskFile, '/F']);
    run('schtasks.exe', ['/Run', '/TN', SERVICE]);
    return SERVICE;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    atomicWrite(plist, macPlist({ node: process.execPath, cliPath: cli, stateDir: config.stateDir, port: config.port }));
    run('plutil', ['-lint', plist]);
    run('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { allowFailure: true });
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
    return LABEL;
  }
  throw new Error('Service installation supports Windows and macOS');
}

export function uninstallService() {
  if (process.platform === 'win32') {
    run('schtasks.exe', ['/End', '/TN', SERVICE], { allowFailure: true });
    run('schtasks.exe', ['/Delete', '/TN', SERVICE, '/F']);
  } else if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    run('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { allowFailure: true });
    if (fs.existsSync(plist)) fs.unlinkSync(plist);
  } else throw new Error('Unsupported platform');
}

export function openBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('Invalid local monitor URL');
  let child;
  if (process.platform === 'win32') child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
  else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  else throw new Error('Browser launcher supports Windows and macOS');
  child.on('error', () => {}); child.unref();
}
