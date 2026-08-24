import { extractFromExchange } from './electron/main/intelligence/extract.js'
import { graphStats, graphSnapshot } from './electron/main/store/graph.js'

console.log('before:', JSON.stringify(graphStats()))
const r = await extractFromExchange(
  'Open my Cascade project and check if the auth middleware still depends on the old session library',
  'Opened Cascade in VS Code. The auth middleware in src/auth/middleware.ts still imports express-session, which Cascade Studio replaced last month. Anirudh flagged this earlier.',
  { cwd: process.env.HOME }
)
console.log('result:', JSON.stringify(r))
console.log('after:', JSON.stringify(graphStats()))
const g = graphSnapshot(20)
for (const e of g.entities) console.log(`  [${e.kind}] ${e.name} (${e.confidence})`)
for (const rel of g.relations) {
  const s = g.entities.find((x) => x.id === rel.sourceId)?.name
  const t = g.entities.find((x) => x.id === rel.targetId)?.name
  console.log(`  ${s} --${rel.kind}--> ${t}`)
}
