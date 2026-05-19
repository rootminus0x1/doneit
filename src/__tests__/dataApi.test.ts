import { describe, it, expect } from 'vitest';
import { isReady } from '../lib/dataApi';

// In vitest, import.meta.env.MODE is 'test', so IS_LOCAL is false.
// isReady(token) = IS_LOCAL || token !== null = false || token !== null
describe('isReady', () => {
    it('returns false when token is null in drive mode', () => {
        expect(isReady(null)).toBe(false);
    });

    it('returns true when token is provided in drive mode', () => {
        expect(isReady('test-token')).toBe(true);
    });
});
