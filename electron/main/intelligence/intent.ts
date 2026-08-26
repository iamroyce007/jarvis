import { db } from '../store/db.js'

/**
 * Intent routing — "Tony asks, JARVIS shows".
 *
 * The interface is not a fixed dashboard; it is whatever the question implies.
 * This module reads the *semantic* shape of what was asked and names the view
 * that answers it, so "who is he" produces a portrait and "where" produces a
 * map without the user ever choosing a mode.
 *
 * Resolution of "he"/"that"/"it" happens here too: a question about a pronoun
 * inherits whatever the conversation was last about.
 */

export type ViewIntent =
  | 'portrait'      // who is he / tell me about this person
  | 'event'         // what happened
  | 'evidence'      // how do you know / show me the source
  | 'timeline'      // when / what happened before this
  | 'map'           // where
  | 'scenario'      // what happens next / what if
  | 'changes'       // what changed / what is different
  | 'spotlight'     // show me
  | 'presentation'  // give me the full story
  | 'briefing'      // general research
  | 'none'          // ordinary conversation or a machine command

export interface Intent {
  view: ViewIntent
  /** Subject the view should be built around, resolved from context if needed. */
  subject: string | null
  /** True when the subject came from context rather than being named. */
  inherited: boolean
}

/** Machine-directed language: never a research or media request. */
const MACHINE =
  /\b(my (mac|computer|screen|file|files|project|code|folder|desktop)|this (file|project|code|screen|window)|the (tests?|logs?|build|terminal|diff|commit|branch|errors?))\b/i

const PRONOUN_SUBJECT = /^(he|him|his|she|her|hers|they|them|their|it|its|that|this|the one|there)$/i

/** Ordered most specific first: the first match wins. */
const ROUTES: { view: ViewIntent; re: RegExp }[] = [
  // Presentation mode — the full assembled story.
  { view: 'presentation', re: /^(?:jarvis[,\s]+)?(?:give me |show me )?the (?:full|whole|complete) (?:story|picture|briefing|rundown)(?:\s+(?:on|about|of)\s+(.+))?$/i },
  { view: 'presentation', re: /^(?:jarvis[,\s]+)?present (?:the )?(?:investigation|findings|briefing)(?:\s+(?:on|about)\s+(.+))?$/i },

  // How do you know — the evidence chain.
  { view: 'evidence', re: /^(?:jarvis[,\s]+)?(?:how do you know|how (?:did|do) you (?:find|figure) (?:that|this) out|what(?:'s| is) your (?:evidence|source)|prove it|says who)(?:\s+(?:about|for)\s+(.+))?$/i },
  { view: 'evidence', re: /^(?:jarvis[,\s]+)?show me (?:the )?(?:source|sources|evidence|proof|citation|citations)(?:\s+(?:for|on|about)\s+(.+))?$/i },
  { view: 'evidence', re: /^(?:jarvis[,\s]+)?why (?:do you|should i) (?:believe|trust) (?:that|this|it)$/i },

  // What changed.
  { view: 'changes', re: /^(?:jarvis[,\s]+)?what(?:'s| is| has)? (?:changed|different|new)(?:\s+(?:with|about|on|in)\s+(.+))?$/i },
  { view: 'changes', re: /^(?:jarvis[,\s]+)?(?:any )?(?:updates?|developments?)(?:\s+(?:on|about)\s+(.+))?$/i },
  { view: 'changes', re: /^(?:jarvis[,\s]+)?since (?:the )?last time(?:\s+.*)?$/i },

  // Futures.
  { view: 'scenario', re: /^(?:jarvis[,\s]+)?what (?:happens|comes) next(?:\s+(?:for|with)\s+(.+))?$/i },
  { view: 'scenario', re: /^(?:jarvis[,\s]+)?what (?:if|would happen if)\s+(.+)$/i },
  { view: 'scenario', re: /^(?:jarvis[,\s]+)?(?:where (?:is|does) (?:this|it) (?:going|head|lead)|how (?:does|will) (?:this|it) (?:play out|end))$/i },
  { view: 'scenario', re: /^(?:jarvis[,\s]+)?(?:project|projections?|scenarios?|possible futures?)(?:\s+(?:for|on|about)\s+(.+))?$/i },

  // Where.
  { view: 'map', re: /^(?:jarvis[,\s]+)?where (?:did (?:this|it|that) happen|is (?:it|this|that)|was (?:it|this|that))$/i },
  { view: 'map', re: /^(?:jarvis[,\s]+)?where (?:is|was|are|were)\s+(.+)$/i },
  { view: 'map', re: /^(?:jarvis[,\s]+)?show me (?:the )?(?:map|location|where)(?:\s+(?:of|for)\s+(.+))?$/i },

  // When / chronology.
  { view: 'timeline', re: /^(?:jarvis[,\s]+)?(?:when did (?:this|it|that) happen|what happened before (?:this|it|that)|what came before)$/i },
  { view: 'timeline', re: /^(?:jarvis[,\s]+)?show me (?:the )?(?:timeline|chronology|sequence)(?:\s+(?:of|for)\s+(.+))?$/i },
  { view: 'timeline', re: /^(?:jarvis[,\s]+)?(?:walk me through|how did we get) (?:the )?(?:timeline|here|there)(?:\s+(?:of|for)\s+(.+))?$/i },
  { view: 'timeline', re: /^(?:jarvis[,\s]+)?when (?:was|did)\s+(.+)$/i },

  // Who — portrait.
  { view: 'portrait', re: /^(?:jarvis[,\s]+)?who (?:is|was|are|were)\s+(.+)$/i },
  { view: 'portrait', re: /^(?:jarvis[,\s]+)?who(?:'s| is)? (?:he|she|they|this|that|this person)$/i },
  { view: 'portrait', re: /^(?:jarvis[,\s]+)?tell me about (?:this|the) person$/i },

  // What happened — event.
  { view: 'event', re: /^(?:jarvis[,\s]+)?what happened(?:\s+(?:with|to|at|in|during)\s+(.+))?$/i },
  { view: 'event', re: /^(?:jarvis[,\s]+)?what(?:'s| is| was) (?:going on|the story)(?:\s+(?:with|about)\s+(.+))?$/i },

  // Show me — media.
  { view: 'spotlight', re: /^(?:jarvis[,\s]+)?(?:show|pull up|bring up|display|put up)\s+(?:me\s+)?(.*)$/i },
  { view: 'spotlight', re: /^(?:jarvis[,\s]+)?what does\s+(.+?)\s+look like$/i },

  // General research.
  { view: 'briefing', re: /^(?:jarvis[,\s]+)?(?:tell me|explain)\s+(?:everything |all |more )?about\s+(.+)$/i },
  { view: 'briefing', re: /^(?:jarvis[,\s]+)?(?:research|investigate|look into|dig into|brief me on)\s+(.+)$/i },
  { view: 'briefing', re: /^(?:jarvis[,\s]+)?(?:full |all )?(?:information|info|details|background|dossier|profile)\s+(?:on|about)\s+(.+)$/i }
]

/**
 * The thing the conversation is currently about.
 *
 * Preference order matters: a person or event is what a pronoun almost always
 * refers to, and a file or concept makes a poor subject for a portrait or map.
 */
export function currentSubject(): string | null {
  const row = db
    .prepare(
      `SELECT name FROM entities
       WHERE kind IN ('person','event','organization','company','place','product','team','project')
       ORDER BY
         CASE kind
           WHEN 'person' THEN 0 WHEN 'event' THEN 1
           WHEN 'organization' THEN 2 WHEN 'company' THEN 2
           ELSE 3 END,
         last_seen DESC
       LIMIT 1`
    )
    .get() as { name?: string } | undefined
  return row?.name ?? null
}

/** Most recent place, used when a map is asked for without naming one. */
function currentPlace(): string | null {
  const row = db
    .prepare(`SELECT name FROM entities WHERE kind = 'place' ORDER BY last_seen DESC LIMIT 1`)
    .get() as { name?: string } | undefined
  return row?.name ?? null
}

/**
 * Classifies a request into the view that should answer it.
 *
 * Returns `none` for ordinary conversation and for anything aimed at this
 * machine, so "run the tests" never redecorates the interface.
 */
export function routeIntent(text: string): Intent {
  const t = text.trim().replace(/[.!?]+$/, '')
  if (!t) return { view: 'none', subject: null, inherited: false }

  // Machine commands own the conversation path, not the visual one.
  if (MACHINE.test(t)) return { view: 'none', subject: null, inherited: false }

  for (const { view, re } of ROUTES) {
    const m = t.match(re)
    if (!m) continue

    // Strip the scaffolding people speak around a subject: a leading "me",
    // possessives, and the media noun itself. "show me his picture" names no
    // subject at all once those are gone, which is the signal to inherit one.
    // Strip the scaffolding people speak around a subject: a leading "me",
    // articles, possessives, the media noun itself, and the preposition left
    // behind once the noun is gone. "show me a picture of Alan Turing" must
    // reduce to "Alan Turing", not "of Alan Turing".
    const raw = (m[1] ?? '')
      .trim()
      .replace(/^me\b\s*/i, '')
      .replace(/\b(?:picture|photo|image|portrait|face|footage|clip|video)s?\b/gi, ' ')
      .replace(/'s\b/g, '')
      .replace(/^\s*(?:a|an|the)\s+/i, '')
      .replace(/^\s*(?:of|about|for|on)\s+/i, '')
      .replace(/^\s*(?:his|her|their|its|my)\s+/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()

    let subject: string | null = raw.length >= 1 && raw.length <= 110 ? raw : null
    let inherited = false

    // A pronoun, or nothing at all, means "what we were just discussing".
    if (!subject || PRONOUN_SUBJECT.test(subject)) {
      subject = view === 'map' ? (currentPlace() ?? currentSubject()) : currentSubject()
      inherited = true
    }

    return { view, subject, inherited }
  }

  // ---- default: anything informational still gets a storyboard -----------
  //
  // The storyboard is not a special mode you have to ask for. Any question
  // seeking knowledge about the world assembles one; only chit-chat and
  // machine commands stay purely conversational.
  const informational = looksInformational(t)
  if (informational) return { view: 'briefing', subject: informational, inherited: false }

  // Direct entity check: If the user inputs a proper name or subject directly (e.g. "Elon Musk", "Nvidia", "Quantum Computing")
  if (!SMALL_TALK.test(t) && !MACHINE.test(t) && t.length >= 2 && t.length <= 100) {
    // Exclude basic conversational phrases
    const notDirectEntity = /^(can you|please|help|how to|why is|why does|where can)\b/i.test(t)
    if (!notDirectEntity) {
      return { view: 'briefing', subject: t, inherited: false }
    }
  }

  return { view: 'none', subject: null, inherited: false }
}

/** Openers that ask about the world rather than about this machine. */
const QUESTION_OPENERS =
  /^(?:jarvis[,\s]+)?(what|who|when|where|why|how|which|is|are|was|were|does|do|did|can|could|should|explain|describe|compare|define|tell|brief|research|show|find)\b/i

/** Conversational filler that deserves no visual at all. */
const SMALL_TALK =
  /^(?:jarvis[,\s]+)?(hi|hey|hello|yo|thanks|thank you|ok|okay|sure|yes|yeah|no|nope|cool|nice|got it|never ?mind|stop|wait|sorry|good (morning|evening|night)|how are you|what'?s up|are you (there|listening|awake))\b/i

/**
 * Extracts the thing an informational question is about.
 *
 * Strips interrogative scaffolding and returns clean subject.
 */
function looksInformational(t: string): string | null {
  if (SMALL_TALK.test(t)) return null
  if (MACHINE.test(t)) return null

  const subject = t
    .replace(/^(?:jarvis[,\s]+)?/i, '')
    .replace(
      /^(what|who|when|where|why|how|which)\s+(is|are|was|were|does|do|did|can|could|should|much|many|long|far)?\s*/i,
      ''
    )
    .replace(/^(is|are|was|were|does|do|did|can|could|should)\s+/i, '')
    .replace(/^(?:tell|explain|describe|show|brief)\s+(?:me\s+)?(?:about|all\s+about|on)?\s*/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/^(?:me\s+)?(?:about|regarding)\s+/i, '')
    .replace(/\?+$/, '')
    .trim()

  if (subject.length < 2 || subject.length > 120) return null
  // Requests to act on this machine are handled conversationally.
  if (/\b(my|this|that)\s+(mac|computer|screen|file|project|code|app|window)\b/i.test(subject)) {
    return null
  }
  return subject
}

/** Whether this view needs a full research pass, or can be assembled locally. */
export function needsResearch(view: ViewIntent): boolean {
  return view === 'briefing' || view === 'event' || view === 'presentation' || view === 'portrait'
}
