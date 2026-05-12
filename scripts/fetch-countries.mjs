import { writeFile } from 'node:fs/promises'

const URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson'
const OUT = 'public/ne_110m_countries.geojson'

console.log(`Fetching ${URL} ...`)
const res = await fetch(URL)
if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
const text = await res.text()
await writeFile(OUT, text)
console.log(`Written ${OUT} (${(text.length / 1024).toFixed(0)} KB)`)
