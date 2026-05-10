'use client'

// Three-step client island: (1) generate secret + QR, (2) verify code,
// (3) display recovery codes ONCE. We render the QR with the `qrcode`
// library to a data URL; falling back to the raw otpauth:// URL if the
// canvas-side render fails.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import QRCode from 'qrcode'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc/client'

type Step = 'generating' | 'verify' | 'recovery' | 'done'

export function Setup2faFlow() {
  const [step, setStep] = useState<Step>('generating')
  const [secret, setSecret] = useState<string | null>(null)
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [acknowledged, setAcknowledged] = useState(false)

  const begin = trpc.account.totp.beginSetup.useMutation({
    onSuccess: (data) => {
      setSecret(data.secret)
      setOtpauthUrl(data.otpauthUrl)
      setStep('verify')
    },
    onError: (e) => toast.error(e.message ?? 'Could not start setup.'),
  })

  const confirm = trpc.account.totp.confirmSetup.useMutation({
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes)
      setStep('recovery')
    },
    onError: (e) => toast.error(e.message ?? 'Could not confirm setup.'),
  })

  // Kick off setup once on mount.
  useEffect(() => {
    if (step === 'generating' && !begin.isPending && !secret) {
      begin.mutate()
    }
    // The mutation is intentionally fire-once; we deliberately do not depend
    // on `begin` so that re-renders never re-issue the setup request.
  }, [step, secret, begin])

  // Render the QR when we have an otpauth URL.
  useEffect(() => {
    if (!otpauthUrl) return
    let cancelled = false
    QRCode.toDataURL(otpauthUrl, { width: 224, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        // Fallback rendered as text below — non-fatal.
      })
    return () => {
      cancelled = true
    }
  }, [otpauthUrl])

  if (step === 'generating') {
    return <p className="text-sm text-neutral-600">Generating your secret…</p>
  }

  if (step === 'verify') {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-neutral-200 bg-white p-4">
          <p className="text-sm text-neutral-700">
            Scan this QR with your Authenticator app (1Password, Google
            Authenticator, Authy, etc.), then enter the 6-digit code it shows.
          </p>
          <div className="mt-3 flex flex-col items-center gap-3">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Two-factor QR code"
                width={224}
                height={224}
                className="rounded-md border border-neutral-200"
              />
            ) : (
              <code className="break-all rounded-md bg-neutral-100 p-2 text-xs">
                {otpauthUrl}
              </code>
            )}
            {secret && (
              <details className="text-xs text-neutral-600">
                <summary className="cursor-pointer">Can't scan? Show secret</summary>
                <code className="mt-2 block break-all rounded-md bg-neutral-100 p-2">
                  {secret}
                </code>
              </details>
            )}
          </div>
        </div>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!secret) return
            confirm.mutate({ secret, code: code.trim() })
          }}
        >
          <Label htmlFor="totp-code">6-digit code</Label>
          <Input
            id="totp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <Button
            type="submit"
            disabled={confirm.isPending || code.replace(/\s/g, '').length !== 6}
            className="w-full"
          >
            {confirm.isPending ? 'Verifying…' : 'Verify and enable'}
          </Button>
        </form>
      </div>
    )
  }

  if (step === 'recovery') {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Save these recovery codes now.</p>
          <p>
            Each code can be used once if you lose access to your Authenticator
            app. They will not be shown again.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 bg-white p-3 font-mono text-sm">
          {recoveryCodes.map((c) => (
            <code key={c} className="rounded bg-neutral-50 px-2 py-1">
              {c}
            </code>
          ))}
        </div>
        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>I have stored these recovery codes somewhere safe.</span>
        </label>
        <Button
          type="button"
          disabled={!acknowledged}
          className="w-full"
          onClick={() => {
            setStep('done')
            // Hard reload so the middleware re-evaluates the enrolment gate.
            window.location.assign('/account')
          }}
        >
          Done
        </Button>
      </div>
    )
  }

  return <p className="text-sm text-neutral-600">Two-factor is now enabled.</p>
}
