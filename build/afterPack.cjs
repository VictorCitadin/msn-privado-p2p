const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, 'MSNMessengerPrivado.exe');
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');
  const localAppData = process.env.LOCALAPPDATA || '';
  const rceditCandidates = [
    path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe'),
    path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign-2.6.0', 'winCodeSign-2.6.0-5puky', 'rcedit-x64.exe')
  ];

  const rcedit = rceditCandidates.find((p) => fs.existsSync(p));
  if (rcedit && fs.existsSync(exePath) && fs.existsSync(iconPath)) {
    try {
      execFileSync(rcedit, [
        exePath,
        '--set-icon',
        iconPath,
        '--set-version-string',
        'ProductName',
        'Vitinho e Will',
        '--set-version-string',
        'FileDescription',
        'Vitinho e Will'
      ]);
      console.log('[afterPack] Embedded 2000s Messenger icon and ProductName into MSNMessengerPrivado.exe');
    } catch (err) {
      console.warn('[afterPack] rcedit warning:', err.message);
    }
  }
};
