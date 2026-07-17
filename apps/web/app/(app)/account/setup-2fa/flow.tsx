'use client'

// Guided Google Authenticator enrolment wizard (CLAUDE.md §20).
//
// Four tutorial steps, standardised on Google Authenticator as the team's
// authenticator app:
//   1. Install Google Authenticator (App Store / Google Play links)
//   2. Add StudyMind CRM to the app (scan QR; manual setup-key fallback)
//   3. Enter the 6-digit code to prove the pairing works
//   4. Save the recovery codes ONCE (copy / download / acknowledge)
//
// The TOTP secret is generated server-side on mount so the QR is ready by
// step 2; nothing is persisted until the code in step 3 verifies. The QR is
// a standard otpauth:// URI, so other TOTP apps also work — the copy simply
// standardises the team on Google Authenticator.

import { useSession } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import QRCode from 'qrcode'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc/client'

type WizardStep = 1 | 2 | 3 | 4

const STEP_LABELS: Record<WizardStep, string> = {
  1: 'Get the app',
  2: 'Scan the code',
  3: 'Verify',
  4: 'Recovery codes',
}

const GOOGLE_AUTHENTICATOR_IOS =
  'https://apps.apple.com/app/google-authenticator/id388497605'
const GOOGLE_AUTHENTICATOR_ANDROID =
  'https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2'

function StepHeader({ current }: { current: WizardStep }) {
  return (
    <ol className="flex items-center gap-1" aria-label="Setup progress">
      {([1, 2, 3, 4] as const).map((n) => {
        const state = n < current ? 'done' : n === current ? 'current' : 'todo'
        return (
          <li key={n} className="flex flex-1 flex-col items-center gap-1">
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ' +
                (state === 'done'
                  ? 'bg-primary-600 text-white'
                  : state === 'current'
                    ? 'border-2 border-primary-600 bg-white text-primary-700'
                    : 'border border-neutral-300 bg-white text-neutral-400')
              }
            >
              {n}
            </span>
            <span
              className={
                'text-center text-[11px] leading-tight ' +
                (state === 'current' ? 'font-medium text-neutral-900' : 'text-neutral-500')
              }
            >
              {STEP_LABELS[n]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function Setup2faFlow() {
  const [step, setStep] = useState<WizardStep>(1)
  const [secret, setSecret] = useState<string | null>(null)
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)

  const begin = trpc.account.totp.beginSetup.useMutation({
    onSuccess: (data) => {
      setSecret(data.secret)
      setOtpauthUrl(data.otpauthUrl)
    },
    onError: (e) => toast.error(e.message ?? 'Could not start setup.'),
  })

  const { update: refreshSession } = useSession()

  const confirm = trpc.account.totp.confirmSetup.useMutation({
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes)
      setStep(4)
      // Refresh the NextAuth session cookie NOW so `totpEnabledAt` propagates
      // to the edge middleware. Without this the mandatory-MFA gate keeps
      // reading the stale (not-enrolled) cookie and bounces the user between
      // /account/setup-2fa and /account (ERR_TOO_MANY_REDIRECTS) — the core
      // "2FA is glitchy" bug. `update()` hits the node /api/auth/session route
      // which re-issues the cookie with the enrolled value.
      void refreshSession()
    },
    onError: (e) =>
      toast.error(
        e.message ?? 'That code did not match — check the app and try again.',
      ),
  })

  // Generate the secret once on mount so the QR is ready by step 2.
  // Fire-once: empty deps so re-renders never re-issue the setup request.
  useEffect(() => {
    if (!begin.isPending && !secret) begin.mutate()
  }, [])

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

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setCopied(true)
      toast.success('Recovery codes copied.')
    } catch {
      toast.error('Could not copy — select and copy the codes manually.')
    }
  }

  function downloadRecoveryCodes() {
    const body = [
      'StudyMind CRM — two-factor recovery codes',
      'Each code can be used once in place of a Google Authenticator code.',
      'Keep this file somewhere safe (e.g. your password manager).',
      '',
      ...recoveryCodes,
    ].join('\n')
    const blob = new Blob([body], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'studymind-crm-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <StepHeader current={step} />

      {step === 1 && (
        <div className="space-y-4">
          <div className="rounded-md border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">
              Install Google Authenticator on your phone
            </h2>
            <p className="mt-1 text-sm text-neutral-700">
              StudyMind uses the free Google Authenticator app to generate your
              sign-in codes. Install it from your phone&apos;s app store — it
              takes under a minute and works offline.
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <a
                  href={GOOGLE_AUTHENTICATOR_IOS}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary-700 hover:underline"
                >
                  iPhone — download from the App Store
                </a>
              </li>
              <li>
                <a
                  href={GOOGLE_AUTHENTICATOR_ANDROID}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary-700 hover:underline"
                >
                  Android — download from Google Play
                </a>
              </li>
            </ul>
            <p className="mt-3 text-xs text-neutral-500">
              Search &ldquo;Google Authenticator&rdquo; in the store if the
              links don&apos;t open on your phone. Already use a different
              authenticator app (1Password, Authy, Microsoft Authenticator)?
              That works too — the steps are the same.
            </p>
          </div>
          <Button type="button" className="w-full" onClick={() => setStep(2)}>
            I have the app — continue
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="rounded-md border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">
              Add StudyMind CRM to Google Authenticator
            </h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-neutral-700">
              <li>Open the Google Authenticator app.</li>
              <li>
                Tap the <span className="font-medium">+</span> button (bottom
                right).
              </li>
              <li>
                Choose <span className="font-medium">Scan a QR code</span>.
              </li>
              <li>Point your phone&apos;s camera at the code below.</li>
            </ol>
            <div className="mt-4 flex flex-col items-center gap-3">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="QR code to scan with Google Authenticator"
                  width={224}
                  height={224}
                  className="rounded-md border border-neutral-200"
                />
              ) : otpauthUrl ? (
                <code className="break-all rounded-md bg-neutral-100 p-2 text-xs">
                  {otpauthUrl}
                </code>
              ) : (
                <p className="text-sm text-neutral-500">Generating your code…</p>
              )}
              {secret && (
                <details className="w-full text-xs text-neutral-600">
                  <summary className="cursor-pointer">
                    Can&apos;t scan? Enter the key manually
                  </summary>
                  <div className="mt-2 space-y-1 rounded-md bg-neutral-100 p-3">
                    <p>
                      In Google Authenticator choose{' '}
                      <span className="font-medium">Enter a setup key</span>{' '}
                      instead, then fill in:
                    </p>
                    <p>
                      Account name: <span className="font-medium">your work email</span>
                    </p>
                    <p className="break-all">
                      Key: <code className="font-mono">{secret}</code>
                    </p>
                    <p>
                      Type of key: <span className="font-medium">Time based</span>
                    </p>
                  </div>
                </details>
              )}
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              After scanning, the app shows a new entry called{' '}
              <span className="font-medium">StudyMind CRM</span> with a 6-digit
              code that changes every 30 seconds.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => setStep(1)}
            >
              Back
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={!otpauthUrl}
              onClick={() => setStep(3)}
            >
              I&apos;ve scanned it — continue
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!secret) return
            confirm.mutate({ secret, code: code.trim() })
          }}
        >
          <div className="rounded-md border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">
              Enter the code from Google Authenticator
            </h2>
            <p className="mt-1 text-sm text-neutral-700">
              Open the app and type the 6-digit code shown under{' '}
              <span className="font-medium">StudyMind CRM</span>. This proves
              the pairing works before we switch it on.
            </p>
            <div className="mt-3 space-y-2">
              <Label htmlFor="totp-code">6-digit code</Label>
              <Input
                id="totp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />
              <p className="text-xs text-neutral-500">
                The code changes every 30 seconds — if it expires while you
                type, just enter the new one.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => setStep(2)}
            >
              Back
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={confirm.isPending || code.replace(/\s/g, '').length !== 6}
            >
              {confirm.isPending ? 'Verifying…' : 'Verify and enable'}
            </Button>
          </div>
        </form>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Save these recovery codes now.</p>
            <p>
              If you lose your phone, a recovery code is the only way back into
              your account — each works once, and they will not be shown again.
              Store them in a password manager or print them.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 bg-white p-3 font-mono text-sm">
            {recoveryCodes.map((c) => (
              <code key={c} className="rounded bg-neutral-50 px-2 py-1">
                {c}
              </code>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={copyRecoveryCodes}
            >
              {copied ? 'Copied' : 'Copy all'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={downloadRecoveryCodes}
            >
              Download .txt
            </Button>
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
              // Hard reload so the middleware re-evaluates the enrolment gate.
              window.location.assign('/account')
            }}
          >
            Finish — two-factor is on
          </Button>
        </div>
      )}
    </div>
  )
}
