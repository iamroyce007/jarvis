import { showMeSubject } from './electron/main/intelligence/spotlight.js'
const tests = [
  "Show me his picture", "show me a picture of Osama bin Laden",
  "show me Alan Turing's photo", "what does Valery Legasov look like",
  "pull up Chernobyl", "show me", "show me the tests", "show me my screen",
  "open Safari"
]
for (const t of tests) {
  const r = showMeSubject(t)
  console.log(`${r ? '✓ ' + JSON.stringify(r) : '· no spotlight'}  ← "${t}"`)
}
