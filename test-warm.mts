import { explain, warmWorkers } from './electron/main/intelligence/explain.js'

console.log('warming…')
const w0 = Date.now()
await warmWorkers(process.env.HOME!)
console.log(`warm in ${((Date.now()-w0)/1000).toFixed(1)}s\n`)

const t0 = Date.now()
let sketchAt = 0
const e = await explain('Alan Turing', {
  cwd: process.env.HOME,
  onProgress: (s) => console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s] ${s}`),
  onStory: (st) => {
    const t = ((Date.now()-t0)/1000)
    if (!sketchAt) sketchAt = t
    console.log(`  [${t.toFixed(1)}s] ★ ${st.provisional ? 'SKETCH' : 'RESEARCHED'} — ${st.frames.length} frames, ${st.facts.length} facts`)
  }
})
console.log(`\nFIRST PAINT ${sketchAt.toFixed(1)}s · FULL ${(e.ms/1000).toFixed(1)}s`)
