/**
 * Wide scan + slave-5 hammer combined.
 * Looks for ANY response (clean or partial) across common slave IDs,
 * then hammers slave 5 specifically with a long burst.
 */

const ModbusRTU = require('modbus-serial');

const HOST = '192.168.1.7';
const PORT = 502;
const TIMEOUT_MS = 2500;
const GAP_MS = 400;
const IDS_TO_SCAN = [1, 3, 4, 5, 7, 8, 9, 10, 50, 88, 100, 247];

async function probe(client, id) {
  client.setID(id);
  client.setTimeout(TIMEOUT_MS);
  try {
    const r = await client.readHoldingRegisters(0, 2);
    return { ok: true, kind: 'clean', data: r.data };
  } catch (e) {
    if (/Data length|CRC|crc|Length|expected/i.test(e.message)) {
      return { ok: false, kind: 'partial', error: e.message };
    }
    return { ok: false, kind: 'timeout', error: e.message };
  }
}

(async () => {
  const client = new ModbusRTU();
  await client.connectTCP(HOST, { port: PORT });
  console.log(`Connected ${HOST}:${PORT}\n`);

  // Sanity
  client.setID(2);
  client.setTimeout(TIMEOUT_MS);
  try {
    const r = await client.readCoils(0, 6);
    console.log(`Bus sanity (Waveshare 2): OK\n`);
  } catch (e) {
    console.log(`Bus sanity FAILED: ${e.message}\n`);
  }

  // Pass 1: wide scan (twice — to catch transient responses)
  for (let pass = 1; pass <= 2; pass++) {
    console.log(`=== Wide scan pass ${pass} ===`);
    for (const id of IDS_TO_SCAN) {
      const r = await probe(client, id);
      const tag = r.ok ? 'CLEAN' : r.kind.toUpperCase();
      const hex = r.ok ? r.data.map(x => x.toString(16).padStart(4, '0')).join(' ') : (r.error || '');
      console.log(`  id ${id.toString().padStart(3)}: ${tag.padEnd(8)} ${hex}`);
      await new Promise(res => setTimeout(res, GAP_MS));
    }
  }

  // Pass 2: hammer slave 5 with 15 trials
  console.log(`\n=== Hammer slave 5 (15 trials) ===`);
  let clean=0, partial=0, timeout=0;
  for (let i = 1; i <= 15; i++) {
    const r = await probe(client, 5);
    const tag = r.ok ? 'CLEAN' : r.kind.toUpperCase();
    const detail = r.ok ? r.data.map(x => x.toString(16).padStart(4, '0')).join(' ') : (r.error || '');
    console.log(`  try ${i.toString().padStart(2)}: ${tag.padEnd(8)} ${detail}`);
    if (r.ok) clean++;
    else if (r.kind === 'partial') partial++;
    else timeout++;
    await new Promise(res => setTimeout(res, GAP_MS));
  }
  console.log(`  -> clean=${clean} partial=${partial} timeout=${timeout}`);

  client.close(() => process.exit(0));
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
