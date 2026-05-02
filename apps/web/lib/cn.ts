// Class name helper. Tiny wrapper around clsx so we have a single import path.

import clsx, { type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs)
}
