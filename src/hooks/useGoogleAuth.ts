import { useState, useCallback } from 'react'
import { useGoogleLogin, googleLogout } from '@react-oauth/google'

export interface AuthState {
  token: string | null
  signIn: () => void
  signOut: () => void
  error: string | null
}

export function useGoogleAuth(): AuthState {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signIn = useGoogleLogin({
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ].join(' '),
    onSuccess: tokenResponse => {
      setToken(tokenResponse.access_token)
      setError(null)
    },
    onError: err => {
      setError(err.error_description ?? 'Sign-in failed')
    },
  })

  const signOut = useCallback(() => {
    googleLogout()
    setToken(null)
  }, [])

  return { token, signIn, signOut, error }
}
