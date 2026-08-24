import { routeIntent } from './electron/main/intelligence/intent.js'
const tests = [
  "Who is he?", "who was Valery Legasov", "What happened?", "what happened at Fukushima",
  "Show me the evidence", "How do you know?", "Where did this happen?", "where is Pripyat",
  "What happens next?", "what if the reactor had held", "What changed?",
  "Show me the timeline", "when did this happen", "Show me", "show me his picture",
  "Give me the full story", "Tell me everything about the Chernobyl disaster",
  // must NOT redecorate:
  "run the tests", "open Safari", "what is on my screen", "fix this file", "yeah sure thanks"
]
for (const t of tests) {
  const r = routeIntent(t)
  const tag = r.view === 'none' ? '·        ' : r.view.toUpperCase().padEnd(13)
  const subj = r.subject ? `${JSON.stringify(r.subject)}${r.inherited ? ' (inherited)' : ''}` : ''
  console.log(`${tag} ${subj.padEnd(34)} ← "${t}"`)
}
