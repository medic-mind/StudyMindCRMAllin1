// Branding logo upload (CLAUDE.md §4). Client island: pick a PNG/JPEG/WebP,
// it uploads to branding.setLogo (CEO/Senior Manager only, audited) and the
// shell logo updates everywhere. Remove falls back to the inline SVG mark.

'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'] as const
const MAX_BYTES = 512 * 1024

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export function BrandingLogoForm({
  initialHasLogo,
  initialVersion,
}: {
  initialHasLogo: boolean
  initialVersion: number | null
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const status = trpc.branding.status.useQuery(undefined, {
    initialData: {
      hasLogo: initialHasLogo,
      contentType: null,
      version: initialVersion,
    },
  })
  const hasLogo = status.data?.hasLogo ?? initialHasLogo
  const version = status.data?.version ?? initialVersion

  const setLogo = trpc.branding.setLogo.useMutation()
  const removeLogo = trpc.branding.removeLogo.useMutation()

  async function handleFile(file: File | undefined) {
    if (!file) return
    if (!(ALLOWED as readonly string[]).includes(file.type)) {
      toast.error('Logo must be a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size > MAX_BYTES) {
      toast.error('Logo must be 512 KB or smaller.')
      return
    }
    setBusy(true)
    try {
      const dataBase64 = await fileToBase64(file)
      await setLogo.mutateAsync({
        dataBase64,
        contentType: file.type as (typeof ALLOWED)[number],
        fileName: file.name,
      })
      toast.success('Logo updated')
      await status.refetch()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleRemove() {
    setBusy(true)
    try {
      await removeLogo.mutateAsync()
      toast.success('Logo removed — using the default mark')
      await status.refetch()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove logo')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-neutral-900">Current logo</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Shown in the top bar and on the sign-in screen. Falls back to the
          built-in StudyMind mark when no logo is set.
        </p>
        <div className="mt-4 flex items-center gap-4">
          <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3">
            {hasLogo ? (
              <img
                src={`/api/branding/logo?v=${version ?? 0}`}
                alt="Current logo"
                className="max-h-12 w-auto object-contain"
              />
            ) : (
              <span className="text-xs text-neutral-400">No custom logo</span>
            )}
          </div>
          {hasLogo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={handleRemove}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-neutral-900">Upload a new logo</h2>
        <p className="mt-1 text-sm text-neutral-500">
          PNG, JPEG, or WebP. Up to 512&nbsp;KB. A wide logo that already
          includes the word &ldquo;StudyMind&rdquo; works best.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED.join(',')}
            disabled={busy}
            onChange={(e) => void handleFile(e.target.files?.[0])}
            className="block w-full text-sm text-neutral-600 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-primary-700 disabled:opacity-50"
          />
        </div>
        {busy ? <p className="mt-3 text-xs text-neutral-500">Uploading…</p> : null}
      </div>
    </div>
  )
}
