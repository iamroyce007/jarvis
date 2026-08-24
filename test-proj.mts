import { project } from './electron/main/intelligence/scenarios.js'
const p = await project('the Chernobyl exclusion zone over the next decade', {
  cwd: process.env.HOME,
  onProgress: (s) => console.log('  …', s)
})
if (p.failure) { console.log('FAILURE:', p.failure); process.exit(1) }
console.log('\nCURRENT STATE:', p.currentState.slice(0, 150))
console.log('\nOBSERVATIONS (checkable now):')
for (const o of p.observations.slice(0, 4)) console.log('  •', o.slice(0, 110))
console.log('\nSCENARIOS:', p.scenarios.length)
for (const s of p.scenarios) {
  console.log(`\n  [${s.likelihood.toUpperCase()}] ${s.title}`)
  console.log(`     ${s.outline.slice(0, 120)}`)
  console.log(`     assumes:    ${s.assumptions[0]?.slice(0, 90) ?? '—'}`)
  console.log(`     falsified by: ${s.falsifiers[0]?.slice(0, 90) ?? 'NONE (would be dropped)'}`)
}
console.log('\nKEY VARIABLES:')
for (const v of p.keyVariables.slice(0, 4)) console.log('  ·', v.slice(0, 100))
