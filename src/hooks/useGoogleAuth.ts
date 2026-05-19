import { useState, useCallback, useEffect, useRef } from 'react';
import { useGoogleLogin, googleLogout } from '@react-oauth/google';
import { authExpiredEvent } from '../lib/authEvents';

export interface AuthState {
    token: string | null;
    signIn: () => void;
    signOut: () => void;
    error: string | null;
    needsReauth: boolean;
}

const SCOPE = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'].join(
    ' ',
);

const SIGNED_IN_KEY = 'doneit-signed-in';

export function useGoogleAuth(): AuthState {
    const [token, setToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [needsReauth, setNeedsReauth] = useState(false);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const silentSignInRef = useRef<(() => void) | null>(null);
    const tokenRef = useRef<string | null>(null);
    tokenRef.current = token;

    // Single registration point: any 401 from Drive API or PMTiles calls fires this
    useEffect(() => {
        authExpiredEvent.register(() => setNeedsReauth(true));
    }, []);

    const scheduleRefresh = useCallback((expiresIn: number) => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        // Refresh 5 minutes before token expires
        const delay = Math.max(0, (expiresIn - 300) * 1000);
        refreshTimerRef.current = setTimeout(() => silentSignInRef.current?.(), delay);
    }, []);

    const silentSignIn = useGoogleLogin({
        scope: SCOPE,
        prompt: 'none',
        onSuccess: response => {
            setToken(response.access_token);
            setNeedsReauth(false);
            setError(null);
            if (response.expires_in) scheduleRefresh(response.expires_in);
        },
        onError: () => {
            localStorage.removeItem(SIGNED_IN_KEY);
            // Only show reconnect if we were already signed in — the timer fired and
            // the silent refresh popup was blocked (common in Chrome).
            if (tokenRef.current !== null) authExpiredEvent.emit();
        },
    });

    useEffect(() => {
        silentSignInRef.current = silentSignIn;
    }, [silentSignIn]);

    // Attempt silent re-auth on mount if user was previously signed in
    useEffect(() => {
        if (localStorage.getItem(SIGNED_IN_KEY)) silentSignIn();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const signIn = useGoogleLogin({
        scope: SCOPE,
        onSuccess: response => {
            setToken(response.access_token);
            setNeedsReauth(false);
            setError(null);
            localStorage.setItem(SIGNED_IN_KEY, '1');
            if (response.expires_in) scheduleRefresh(response.expires_in);
        },
        onError: err => {
            setError(err.error_description ?? 'Sign-in failed');
        },
    });

    const signOut = useCallback(() => {
        googleLogout();
        setToken(null);
        setNeedsReauth(false);
        localStorage.removeItem(SIGNED_IN_KEY);
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    }, []);

    return { token, signIn, signOut, error, needsReauth };
}
