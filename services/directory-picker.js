const { execFile } = require('child_process');

function createSystemDirectoryPicker() {
  return {
    canPickDir() {
      return process.platform === 'win32';
    },

    pickDirectory(options = {}) {
      if (!this.canPickDir()) return Promise.reject(new Error('no_native'));
      const title = String(options.title || '选择下载目录').replace(/'/g, "''");
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$dialog.Description = '${title}'`,
        '$dialog.ShowNewFolderButton = $true',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  Write-Output $dialog.SelectedPath',
        '  exit 0',
        '}',
        'exit 2'
      ].join('; ');

      return new Promise((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { windowsHide: false, timeout: 0 },
          (error, stdout, stderr) => {
            if (error) {
              if (error.code === 2) return resolve({ canceled: true, filePaths: [] });
              return reject(new Error((stderr || error.message || 'no_native').trim()));
            }
            const dir = String(stdout || '').trim();
            resolve(dir ? { canceled: false, filePaths: [dir] } : { canceled: true, filePaths: [] });
          }
        );
      });
    }
  };
}

module.exports = { createSystemDirectoryPicker };
