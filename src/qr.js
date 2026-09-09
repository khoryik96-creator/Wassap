import path from 'node:path';
import { dataDir } from './config.js';

/** The QR as terminal block characters. Returned rather than printed, so it is testable. */
export async function renderQrText(qr) {
  const { default: qrcode } = await import('qrcode-terminal');
  return new Promise((resolve) => qrcode.generate(qr, { small: true }, resolve));
}

/**
 * Mirror the QR to a PNG, for terminals where the block characters are hard
 * for a phone camera to read. Returns the path, or null if it could not write.
 */
export async function writeQrImage(qr, file = path.join(dataDir(), 'qr.png')) {
  try {
    const { default: qrImage } = await import('qrcode');
    await qrImage.toFile(file, qr, { width: 512, margin: 2 });
    return file;
  } catch {
    return null; // the terminal code is still usable on its own
  }
}

/**
 * Present one QR code. `attempt` is 1 for the first and increases on every
 * refresh, because only the newest code will actually link.
 */
export async function showQr(qr, attempt, onStatus, write = process.stdout.write.bind(process.stdout)) {
  if (attempt === 1) {
    onStatus('Scan this QR code in WhatsApp: Settings > Linked devices > Link a device');
  } else {
    onStatus(`QR code refreshed (#${attempt}) - the previous one has expired, scan this one:`);
  }

  write(`${await renderQrText(qr)}\n`);
  return writeQrImage(qr);
}

