import { research } from './electron/main/intelligence/briefing.js'

const b = await research('Chernobyl disaster', {
  cwd: process.env.HOME,
  onProgress: (s) => console.log('  …', s)
})
if (b.failure) { console.log('FAILURE:', b.failure); process.exit(1) }

console.log('\nHEADLINE:', b.headline)
console.log('HERO IMAGE:', b.hero?.image ? b.hero.image.slice(0, 70) : 'none', '|', b.hero?.credit)
console.log('\nSTORYBOARD —', b.frames.length, 'frames')
for (const [i, f] of b.frames.entries()) {
  const img = f.media?.image ? '🖼' : '  '
  console.log(`  ${String(i+1).padStart(2)}. ${img} [${f.kind.toUpperCase().padEnd(10)}] ${f.title}`)
  console.log(`         "${f.narration.slice(0, 88)}"`)
  if (f.subject) console.log(`         subject: ${f.subject}${f.media?.credit ? ' — ' + f.media.credit : ' (no image)'}`)
  if (f.sides) for (const sd of f.sides) console.log(`         VS: ${sd.claim.slice(0,70)} [src ${sd.source}]`)
  if (f.value) console.log(`         ${f.value} ${f.unit ?? ''}`)
}
console.log('\nSOURCES:', b.sources.length, '| verified:', b.sources.filter(s=>s.reachable).length)
console.log('OPEN QUESTIONS:', b.openQuestions.length)
