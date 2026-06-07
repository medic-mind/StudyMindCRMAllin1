// Pure phone-number data + helpers (no React) so they can be unit-tested
// without a DOM. The <PhoneInput> component in phone-input.tsx renders these.
// Country names + flags are reused from countries.ts; dial codes live here.
// Output is E.164 — the CRM's stored format (CLAUDE.md §29).

import { COUNTRIES, type Country } from './countries'

/** ISO 3166-1 alpha-2 (lower-case) → ITU dialling code (no leading +). */
export const DIAL: Record<string, string> = {
  af: '93', ax: '358', al: '355', dz: '213', as: '1684', ad: '376', ao: '244',
  ai: '1264', ag: '1268', ar: '54', am: '374', aw: '297', au: '61', at: '43',
  az: '994', bs: '1242', bh: '973', bd: '880', bb: '1246', by: '375', be: '32',
  bz: '501', bj: '229', bm: '1441', bt: '975', bo: '591', ba: '387', bw: '267',
  br: '55', io: '246', bn: '673', bg: '359', bf: '226', bi: '257', cv: '238',
  kh: '855', cm: '237', ca: '1', ky: '1345', cf: '236', td: '235', cl: '56',
  cn: '86', co: '57', km: '269', cg: '242', cd: '243', ck: '682', cr: '506',
  ci: '225', hr: '385', cu: '53', cw: '599', cy: '357', cz: '420', dk: '45',
  dj: '253', dm: '1767', do: '1809', ec: '593', eg: '20', sv: '503', gq: '240',
  er: '291', ee: '372', sz: '268', et: '251', fk: '500', fo: '298', fj: '679',
  fi: '358', fr: '33', gf: '594', pf: '689', ga: '241', gm: '220', ge: '995',
  de: '49', gh: '233', gi: '350', gr: '30', gl: '299', gd: '1473', gp: '590',
  gu: '1671', gt: '502', gg: '44', gn: '224', gw: '245', gy: '592', ht: '509',
  hn: '504', hk: '852', hu: '36', is: '354', in: '91', id: '62', ir: '98',
  iq: '964', ie: '353', im: '44', il: '972', it: '39', jm: '1876', jp: '81',
  je: '44', jo: '962', kz: '7', ke: '254', ki: '686', kp: '850', kr: '82',
  kw: '965', kg: '996', la: '856', lv: '371', lb: '961', ls: '266', lr: '231',
  ly: '218', li: '423', lt: '370', lu: '352', mo: '853', mg: '261', mw: '265',
  my: '60', mv: '960', ml: '223', mt: '356', mh: '692', mq: '596', mr: '222',
  mu: '230', yt: '262', mx: '52', fm: '691', md: '373', mc: '377', mn: '976',
  me: '382', ms: '1664', ma: '212', mz: '258', mm: '95', na: '264', nr: '674',
  np: '977', nl: '31', nc: '687', nz: '64', ni: '505', ne: '227', ng: '234',
  nu: '683', nf: '672', mk: '389', mp: '1670', no: '47', om: '968', pk: '92',
  pw: '680', ps: '970', pa: '507', pg: '675', py: '595', pe: '51', ph: '63',
  pl: '48', pt: '351', pr: '1787', qa: '974', re: '262', ro: '40', ru: '7',
  rw: '250', bl: '590', sh: '290', kn: '1869', lc: '1758', mf: '590',
  pm: '508', vc: '1784', ws: '685', sm: '378', st: '239', sa: '966', sn: '221',
  rs: '381', sc: '248', sl: '232', sg: '65', sx: '1721', sk: '421', si: '386',
  sb: '677', so: '252', za: '27', ss: '211', es: '34', lk: '94', sd: '249',
  sr: '597', sj: '47', se: '46', ch: '41', sy: '963', tw: '886', tj: '992',
  tz: '255', th: '66', tl: '670', tg: '228', tk: '690', to: '676', tt: '1868',
  tn: '216', tr: '90', tm: '993', tc: '1649', tv: '688', ug: '256', ua: '380',
  ae: '971', gb: '44', us: '1', uy: '598', uz: '998', vu: '678', va: '39',
  ve: '58', vn: '84', vg: '1284', vi: '1340', wf: '681', eh: '212', ye: '967',
  zm: '260', zw: '263', xk: '383', bq: '599', cc: '61', cx: '61',
}

/** For dial codes shared by several countries, the one to show when parsing an
 *  E.164 back to a country (cosmetic — the stored E.164 is identical either way). */
const PRIMARY_FOR_DIAL: Record<string, string> = {
  '1': 'us',
  '7': 'ru',
  '39': 'it',
  '44': 'gb',
  '47': 'no',
  '61': 'au',
  '212': 'ma',
  '262': 're',
  '358': 'fi',
  '590': 'gp',
  '599': 'cw',
}

export const DEFAULT_ISO = 'gb'

export interface PhoneCountry extends Country {
  dial: string
}

/** Countries that have a dial code, in the alphabetical order COUNTRIES uses. */
export const PHONE_COUNTRIES: PhoneCountry[] = COUNTRIES.filter((c) => DIAL[c.code]).map((c) => ({
  ...c,
  dial: DIAL[c.code]!,
}))

const DIAL_TO_COUNTRY: Map<string, PhoneCountry> = (() => {
  const map = new Map<string, PhoneCountry>()
  for (const c of PHONE_COUNTRIES) {
    if (!map.has(c.dial)) map.set(c.dial, c)
  }
  for (const [dial, iso] of Object.entries(PRIMARY_FOR_DIAL)) {
    const c = PHONE_COUNTRIES.find((x) => x.code === iso)
    if (c) map.set(dial, c)
  }
  return map
})()

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

/** Parse an E.164-ish value into a country + national number. Falls back to the
 *  default country when there's no leading "+" or no recognised code. */
export function parsePhone(value: string | null | undefined): {
  iso: string
  national: string
} {
  const v = (value ?? '').trim()
  if (!v) return { iso: DEFAULT_ISO, national: '' }
  const digits = digitsOnly(v)
  if (v.startsWith('+')) {
    for (let len = 4; len >= 1; len--) {
      const prefix = digits.slice(0, len)
      const c = DIAL_TO_COUNTRY.get(prefix)
      if (c) return { iso: c.code, national: digits.slice(len) }
    }
  }
  // No "+" (or unknown code): treat as a local number under the default country.
  return { iso: DEFAULT_ISO, national: digits }
}

/** Build the E.164 string from a country + national number. Strips the national
 *  trunk "0" prefix. Returns "" when there's no number (an empty phone field). */
export function composePhone(iso: string, national: string): string {
  const dial = DIAL[iso]
  const nat = digitsOnly(national).replace(/^0+/, '')
  if (!dial || nat.length === 0) return ''
  return `+${dial}${nat}`
}
