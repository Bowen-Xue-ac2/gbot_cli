import { execFile } from 'node:child_process';
import { join } from 'node:path';
import stringWidth from 'string-width';

export function browserUrl(value) {
  if (!/^https?:\/\//i.test(value ?? '') || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return;
  return URL.parse(value)?.href;
}

export function linkAtPoint(rows, transcript, x, y, measure) {
  if (!transcript) return;
  const pane = measure(transcript);
  if (x <= pane.x || x >= pane.x + pane.width - 1 ||
      y <= pane.y || y >= pane.y + pane.height - 1) return;
  for (const { node, spans } of rows.values()) {
    const row = measure(node);
    if (y !== row.y || x < row.x || x >= row.x + row.width) continue;
    let column = row.x;
    for (const span of spans) {
      column += stringWidth(span.text);
      if (x < column) return span.href;
    }
  }
}

export function openBrowserLink(value) {
  const url = browserUrl(value);
  if (!url) return Promise.reject(new Error('Invalid browser link.'));
  const powershell = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:GBOT_BROWSER_URL -ErrorAction Stop',
    ], { windowsHide: true, env: { ...process.env, GBOT_BROWSER_URL: url } },
    error => error ? reject(error) : resolve());
  });
}
