import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAddress } from '../src/services/maps.js';

test('malformed geocoder responses never copy provider/customer data into production logs', async () => {
  const fetch = globalThis.fetch, warn = console.warn;
  const lines = [];
  globalThis.fetch = async () => new Response('privatePII-address-and-phone invalid JSON', { status:200 });
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await assert.rejects(searchAddress('privatePII-address', 'ar'), error => error.code === 'maps_unavailable');
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines.join('\n'), /privatePII/);
    assert.match(lines[0], /maps.*failed/);
  } finally { globalThis.fetch = fetch; console.warn = warn; }
});
