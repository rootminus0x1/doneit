let _handler: (() => void) | null = null;

export const authExpiredEvent = {
    register: (fn: () => void) => { _handler = fn; },
    emit: () => { _handler?.(); },
};
