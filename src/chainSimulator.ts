import { spawn } from 'node:child_process';
import * as path from 'path';

function getChainSimulatorBinPath() {
  switch (process.platform) {
    case 'linux':
      return path.join(__dirname, '..', 'bin', 'chainsimulator');
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export const startChainSimulator = (port?: number): Promise<string> => {
  if (!port) {
    port = 8085;
  }

  return new Promise((resolve, reject) => {
    console.log('Starting chain simulator...');

    const server = spawn(`${getChainSimulatorBinPath()}`, ['--server-port', port.toString()]);

    const timeout = setTimeout(() => reject(new Error('Simulnet failed starting.')), 30_000);

    server.stdout.on('data', (data) => {
      // console.log(data.toString());

      const activeRegex = /shard 4294967295 active nodes/;
      const match = data.toString().match(activeRegex);
      if (match) {
        clearTimeout(timeout);

        // Wait a bit more after to make sure it is really started
        setTimeout(() => resolve(`http://localhost:${port}`), 500);
      }
    });

    server.stderr.on('data', (data: Buffer) => {
      throw new Error(data.toString());
    });

    server.on('error', (error) => {
      throw error;
    });
  });
};