import { research } from './electron/main/intelligence/briefing.js'

const b = await research('Osama bin Laden', {
  cwd: process.env.HOME,
  onProgress: (s) => console.log('  …', s)
})

if (b.failure) { console.log('FAILURE:', b.failure); process.exit(1) }

console.log('\nHEADLINE:', b.headline)
console.log('KIND:', b.kind, '| ms:', b.ms)
console.log('SUMMARY:', b.summary.slice(0, 220))
console.log('\nSECTIONS:', b.sections.length)
for (const s of b.sections) console.log(`  [${s.confidence}] ${s.title}  (srcs: ${s.sources.join(',') || 'none'})`)
console.log('\nTIMELINE:', b.timeline.length)
for (const t of b.timeline.slice(0, 6)) console.log(`  ${t.date} — ${t.label} [${t.confidence}]`)
console.log('\nSOURCES:', b.sources.length)
for (const s of b.sources) {
  console.log(`  [${s.reachable ? 'VERIFIED' : 'UNREACHABLE'}] ${s.domain} — ${s.title.slice(0, 55)}`)
  if (s.image) console.log(`      image: ${s.image.slice(0, 80)}`)
}
console.log('\nOPEN QUESTIONS:', b.openQuestions.length)
for (const q of b.openQuestions.slice(0, 4)) console.log('  ?', q)
