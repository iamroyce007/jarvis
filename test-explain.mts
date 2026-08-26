import { explain } from './electron/main/intelligence/explain.js'

const t0 = Date.now()
let textAt = 0
const e = await explain('Osama bin Laden', {
  cwd: process.env.HOME,
  onProgress: (s) => console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s] ${s}`),
  onStory: () => { textAt = Date.now() - t0; console.log(`  [${(textAt/1000).toFixed(1)}s] ★ STORY READY (text on screen)`) },
  onMedia: (id, m) => console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s]   + image ${m.credit}`)
})
if (e.failure) { console.log('FAILURE:', e.failure); process.exit(1) }

console.log(`\nTEXT IN ${(textAt/1000).toFixed(1)}s · FULL IN ${(e.ms/1000).toFixed(1)}s`)
console.log('\nHEADLINE:', e.headline)
console.log('\nFACTS —', e.facts.length)
for (const f of e.facts) console.log(`  ${f.label.padEnd(18)} ${f.value}`)
console.log('\nFRAMES —', e.frames.length)
for (const f of e.frames) {
  console.log(`  ${f.media ? '🖼' : '  '} [${f.kind.toUpperCase().padEnd(10)}] ${f.title}`)
  if (f.facts?.length) for (const x of f.facts) console.log(`         · ${x.label}: ${x.value}`)
  if (f.timeline?.length) console.log(`         · ${f.timeline.length} timeline entries`)
  if (f.sides?.length) for (const s of f.sides) console.log(`         VS ${s.claim.slice(0,64)}`)
  if (f.value) console.log(`         ${f.value} ${f.unit ?? ''}`)
}
console.log('\nSOURCES:', e.sources.length, '| RELATED:', e.relatedSubjects.join(', '))
