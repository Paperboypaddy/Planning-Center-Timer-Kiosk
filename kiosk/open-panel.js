'use strict';

// Opens the control panel in the default browser (cross-platform). Used by
// the Windows/macOS installers for the "Kiosk Control panel" shortcut.

const os = require('os');
const { execFile } = require('child_process');

const url = `https://${os.hostname()}.local`;

if (process.platform === 'win32') {
  execFile('cmd', ['/c', 'start', '', url]);
} else if (process.platform === 'darwin') {
  execFile('open', [url]);
} else {
  execFile('xdg-open', [url]);
}
