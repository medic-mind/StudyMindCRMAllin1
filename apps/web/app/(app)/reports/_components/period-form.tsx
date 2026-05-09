// Shared period (from/to) form. RSC-friendly: uses native form GET, so the
// from/to query params drive RSC re-render.

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function PeriodForm({ fromIso, toIso }: { fromIso: string; toIso: string }) {
  return (
    <form className="flex items-end gap-2" method="GET">
      <label className="flex flex-col text-xs text-neutral-600">
        From
        <Input type="date" name="from" defaultValue={fromIso} />
      </label>
      <label className="flex flex-col text-xs text-neutral-600">
        To
        <Input type="date" name="to" defaultValue={toIso} />
      </label>
      <Button type="submit" variant="secondary">
        Update
      </Button>
    </form>
  )
}
