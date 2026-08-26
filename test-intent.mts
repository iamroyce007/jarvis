import { routeIntent } from './electron/main/intelligence/intent.js'
const tests = [
  // should build a storyboard by default
  "what is quantum computing",
  "how does nuclear fission work",
  "why did the Soviet Union collapse",
  "explain the 2008 financial crisis",
  "who was Valery Legasov",
  "what happened at Fukushima",
  "show me a picture of Alan Turing",
  "compare SpaceX and Blue Origin",
  // should stay conversational
  "hey", "thanks", "yeah cool", "are you there",
  "run the tests", "open Safari", "fix this file", "what is on my screen"
]
for (const t of tests) {
  const r = routeIntent(t)
  const tag = r.view === 'none' ? '· talk       ' : r.view.toUpperCase().padEnd(13)
  console.log(`${tag} ${(r.subject ?? '').padEnd(34)} ← "${t}"`)
}
