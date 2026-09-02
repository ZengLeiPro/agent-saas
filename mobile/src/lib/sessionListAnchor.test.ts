import { beforeEach, expect, it } from 'vitest';
import { captureSessionListAnchor, readSessionListAnchor, resetSessionListAnchor } from './sessionListAnchor';

beforeEach(resetSessionListAnchor);

it('M20-07 preserves the list anchor across session switches/returns', () => {
  captureSessionListAnchor(864);
  expect(readSessionListAnchor()).toBe(864);
  captureSessionListAnchor(Number.NaN);
  expect(readSessionListAnchor()).toBe(864);
});
