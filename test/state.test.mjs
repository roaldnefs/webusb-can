import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GS_USB_FILTERS } from '../js/state.js';

const hasFilter = (vendorId, productId) =>
  GS_USB_FILTERS.some(f => f.vendorId === vendorId && f.productId === productId);

test('device picker offers candleLight adapters', () => {
  assert.ok(hasFilter(0x1D50, 0x606F));
});

test('device picker offers CANnectivity adapters', () => {
  assert.ok(hasFilter(0x1209, 0xCA01));
});
