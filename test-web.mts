import { resolveFromWeb } from './electron/main/intelligence/webmedia.js'
const r = await resolveFromWeb('Osama bin Laden', {
  cwd: process.env.HOME,
  onProgress: (s) => console.log('  …', s)
})
if (r.failure) { console.log('FAILURE:', r.failure); process.exit(1) }
console.log('\nPAGES CONSULTED:')
for (const p of r.pages) console.log(`  ${p.publisher.padEnd(24)} ${p.title.slice(0, 58)}`)
console.log('\nHERO:', r.hero ? `${r.hero.publisher} — ${r.hero.url.slice(0, 78)}` : 'none')
console.log('\nMEDIA WALL:', r.images.length, 'verified images')
for (const i of r.images) console.log(`  [${i.publisher.padEnd(22)}] ${i.url.slice(0, 74)}`)
console.log('\nDESCRIPTION:', r.description?.slice(0, 150) ?? 'none')
console.log('EXTRACT:', r.extract?.slice(0, 190) ?? 'none')
