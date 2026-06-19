// Curated English given-name nickname map for the OPT-IN fuzzy matcher
// (CLAUDE.md §3 — exact matching is the default; fuzzy is only used by the Slack
// resolver, and always behind the "exactly one contact" guard). Bidirectional:
// "Liz" expands to "Elizabeth" and vice-versa, and siblings share through the
// canonical form. Deterministic, no AI.

const NICKNAMES: Record<string, readonly string[]> = {
  abigail: ['abby', 'abbie'],
  alexander: ['alex', 'xander', 'sandy', 'al'],
  alexandra: ['alex', 'lexi', 'sandra', 'sandy'],
  andrew: ['andy', 'drew'],
  anthony: ['tony', 'ant'],
  benjamin: ['ben', 'benny', 'benji'],
  bernard: ['bernie'],
  catherine: ['cathy', 'kate', 'katie', 'cat', 'cath'],
  charles: ['charlie', 'chuck', 'chas'],
  christopher: ['chris', 'kit'],
  christina: ['chris', 'tina', 'chrissy'],
  daniel: ['dan', 'danny'],
  david: ['dave', 'davey'],
  deborah: ['deb', 'debbie'],
  dorothy: ['dot', 'dottie'],
  edward: ['ed', 'eddie', 'ted', 'ned'],
  elizabeth: ['liz', 'lizzie', 'beth', 'betty', 'eliza', 'libby', 'liza'],
  emily: ['em', 'emmy'],
  frederick: ['fred', 'freddie'],
  gabriel: ['gabe'],
  geoffrey: ['geoff'],
  gregory: ['greg'],
  harold: ['harry', 'hal'],
  henry: ['harry', 'hank'],
  isabella: ['bella', 'izzy'],
  isabelle: ['izzy', 'belle'],
  jacob: ['jake'],
  james: ['jim', 'jimmy', 'jamie'],
  jennifer: ['jen', 'jenny'],
  jonathan: ['jon', 'jonny', 'john'],
  joseph: ['joe', 'joey'],
  joshua: ['josh'],
  katherine: ['kate', 'katie', 'kathy', 'kat', 'kath'],
  kenneth: ['ken', 'kenny'],
  lawrence: ['larry', 'laurie'],
  leonard: ['len', 'lenny', 'leo'],
  margaret: ['maggie', 'meg', 'peggy', 'margo', 'madge'],
  matthew: ['matt', 'matty'],
  megan: ['meg'],
  michael: ['mike', 'mikey', 'mick'],
  nicholas: ['nick', 'nicky'],
  nicole: ['nikki'],
  patricia: ['pat', 'tricia', 'patty', 'trish'],
  patrick: ['pat', 'paddy'],
  peter: ['pete'],
  philip: ['phil'],
  rebecca: ['becca', 'becky', 'bex'],
  richard: ['rich', 'rick', 'dick', 'richie'],
  robert: ['rob', 'bob', 'bobby', 'robbie'],
  ronald: ['ron', 'ronnie'],
  samuel: ['sam', 'sammy'],
  samantha: ['sam', 'sammy'],
  stephen: ['steve', 'stevie'],
  steven: ['steve', 'stevie'],
  stephanie: ['steph', 'steff'],
  susan: ['sue', 'susie', 'suzie'],
  theodore: ['theo', 'ted'],
  thomas: ['tom', 'tommy'],
  timothy: ['tim', 'timmy'],
  victoria: ['vicky', 'tori', 'vic'],
  william: ['will', 'bill', 'billy', 'liam', 'willy'],
  zachary: ['zach', 'zak', 'zac'],
}

// Reverse index built once: token -> set of equivalent tokens (canonical +
// nicknames sharing it).
const EQUIVALENTS: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    if (!map.has(a)) map.set(a, new Set())
    map.get(a)!.add(b)
  }
  for (const [canon, nicks] of Object.entries(NICKNAMES)) {
    for (const n of nicks) {
      link(canon, n)
      link(n, canon)
      // Siblings of the same canonical name are equivalent to each other.
      for (const m of nicks) if (m !== n) link(n, m)
    }
  }
  return map
})()

/**
 * All forms of a single given-name token to try, including the token itself.
 * "liz" -> ["liz","elizabeth","lizzie","beth",...]; an unknown token returns
 * just itself. Lower-cased.
 */
export function nameVariants(token: string): string[] {
  const t = token.trim().toLowerCase()
  if (!t) return []
  const out = new Set<string>([t])
  const eq = EQUIVALENTS.get(t)
  if (eq) for (const v of eq) out.add(v)
  return [...out]
}
