'use strict';

const { spawn } = require('node:child_process');

const SUPPORTED = process.platform === 'win32';
const READY_MARKER = 'VELOS_REMOTE_INPUT_READY';

const POWERSHELL_AGENT = [
  "$ErrorActionPreference = 'Stop'",
  '$nativeSource = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class VelosRemoteInput {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $nativeSource -Language CSharp',
  "$heldKeys = New-Object 'System.Collections.Generic.HashSet[int]'",
  "$heldButtons = New-Object 'System.Collections.Generic.HashSet[string]'",
  "[Console]::Out.WriteLine('" + READY_MARKER + "')",
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  '  try {',
  '    $command = $line | ConvertFrom-Json',
  '    switch ([string]$command.type) {',
  "      'move' {",
  '        $width = [Math]::Max(1, [VelosRemoteInput]::GetSystemMetrics(0))',
  '        $height = [Math]::Max(1, [VelosRemoteInput]::GetSystemMetrics(1))',
  '        $x = [int][Math]::Round(([double]$command.x) * ($width - 1))',
  '        $y = [int][Math]::Round(([double]$command.y) * ($height - 1))',
  '        [void][VelosRemoteInput]::SetCursorPos($x, $y)',
  '      }',
  "      'button-down' {",
  '        $flags = switch ([string]$command.button) {',
  "          'left' { 0x0002 } 'right' { 0x0008 } 'middle' { 0x0020 } default { 0 }",
  '        }',
  '        if ($flags -ne 0) {',
  '          [VelosRemoteInput]::mouse_event([uint32]$flags, 0, 0, 0, [UIntPtr]::Zero)',
  '          [void]$heldButtons.Add([string]$command.button)',
  '        }',
  '      }',
  "      'button-up' {",
  '        $flags = switch ([string]$command.button) {',
  "          'left' { 0x0004 } 'right' { 0x0010 } 'middle' { 0x0040 } default { 0 }",
  '        }',
  '        if ($flags -ne 0) {',
  '          [VelosRemoteInput]::mouse_event([uint32]$flags, 0, 0, 0, [UIntPtr]::Zero)',
  '          [void]$heldButtons.Remove([string]$command.button)',
  '        }',
  '      }',
  "      'wheel' {",
  '        $delta = [int][Math]::Max(-120, [Math]::Min(120, [int]$command.delta))',
  '        if ($delta -ne 0) { [VelosRemoteInput]::mouse_event([uint32]0x0800, 0, 0, $delta, [UIntPtr]::Zero) }',
  '      }',
  "      'key-down' {",
  '        $key = [int]$command.keyCode',
  '        if ($key -gt 0 -and $key -lt 256) {',
  '          [VelosRemoteInput]::keybd_event([byte]$key, 0, [uint32]0, [UIntPtr]::Zero)',
  '          [void]$heldKeys.Add($key)',
  '        }',
  '      }',
  "      'key-up' {",
  '        $key = [int]$command.keyCode',
  '        if ($key -gt 0 -and $key -lt 256) {',
  '          [VelosRemoteInput]::keybd_event([byte]$key, 0, [uint32]2, [UIntPtr]::Zero)',
  '          [void]$heldKeys.Remove($key)',
  '        }',
  '      }',
  "      'release-all' {",
  '        foreach ($key in @($heldKeys)) { [VelosRemoteInput]::keybd_event([byte]$key, 0, [uint32]2, [UIntPtr]::Zero) }',
  '        foreach ($button in @($heldButtons)) {',
  '          $flags = switch ($button) {',
  "            'left' { 0x0004 } 'right' { 0x0010 } 'middle' { 0x0040 } default { 0 }",
  '          }',
  '          if ($flags -ne 0) { [VelosRemoteInput]::mouse_event([uint32]$flags, 0, 0, 0, [UIntPtr]::Zero) }',
  '        }',
  '        $heldKeys.Clear()',
  '        $heldButtons.Clear()',
  '      }',
  '    }',
  '  } catch { [Console]::Error.WriteLine($_.Exception.Message) }',
  '}'
].join('\n');

let child = null;
let ready = false;
let starting = null;

function isSupported() {
  return SUPPORTED;
}

function start() {
  if (!SUPPORTED) return Promise.resolve(false);
  if (ready && child && child.exitCode === null) return Promise.resolve(true);
  if (starting) return starting;

  starting = new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ready = ok;
      if (!ok && child) {
        try { child.kill(); } catch (_) {}
        child = null;
      }
      resolve(ok);
    };

    try {
      child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', POWERSHELL_AGENT
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (_) {
      finish(false);
      return;
    }

    const timeout = setTimeout(() => finish(false), 6000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(READY_MARKER)) finish(true);
    });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(false));
    child.once('exit', () => {
      ready = false;
      child = null;
      if (!settled) finish(false);
    });
    child.stdin.on('error', () => { ready = false; });
  }).finally(() => {
    starting = null;
  });

  return starting;
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object') return null;
  switch (input.type) {
    case 'move':
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return null;
      return {
        type: 'move',
        x: Math.max(0, Math.min(1, input.x)),
        y: Math.max(0, Math.min(1, input.y))
      };
    case 'button-down':
    case 'button-up':
      return ['left', 'right', 'middle'].includes(input.button)
        ? { type: input.type, button: input.button }
        : null;
    case 'wheel':
      return Number.isFinite(input.delta)
        ? { type: 'wheel', delta: Math.max(-120, Math.min(120, Math.trunc(input.delta))) }
        : null;
    case 'key-down':
    case 'key-up':
      return Number.isInteger(input.keyCode) && input.keyCode > 0 && input.keyCode < 256
        ? { type: input.type, keyCode: input.keyCode }
        : null;
    case 'release-all':
      return { type: 'release-all' };
    default:
      return null;
  }
}

function sendInput(input) {
  const command = normalizeInput(input);
  if (!command || !ready || !child || child.exitCode !== null || !child.stdin.writable) return false;
  try {
    return child.stdin.write(JSON.stringify(command) + '\n');
  } catch (_) {
    return false;
  }
}

function releaseAll() {
  return sendInput({ type: 'release-all' });
}

function stop() {
  releaseAll();
  ready = false;
  if (child) {
    try { child.stdin.end(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    child = null;
  }
  starting = null;
}

module.exports = { isSupported, start, sendInput, releaseAll, stop };
