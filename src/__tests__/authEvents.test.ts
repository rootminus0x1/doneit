import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authExpiredEvent } from '../lib/authEvents';

describe('authExpiredEvent', () => {
    beforeEach(() => {
        authExpiredEvent.register(null as unknown as () => void);
    });

    it('calls the registered handler when emitted', () => {
        const fn = vi.fn();
        authExpiredEvent.register(fn);
        authExpiredEvent.emit();
        expect(fn).toHaveBeenCalledOnce();
    });

    it('does not throw when no handler is registered', () => {
        expect(() => authExpiredEvent.emit()).not.toThrow();
    });

    it('replaces a previous handler when register is called again', () => {
        const first = vi.fn();
        const second = vi.fn();
        authExpiredEvent.register(first);
        authExpiredEvent.register(second);
        authExpiredEvent.emit();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();
    });
});
