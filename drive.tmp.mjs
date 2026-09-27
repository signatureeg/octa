// node drive.mjs <js expression evaluated in the renderer>
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9229')
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('overlay')) ?? browser.contexts()[0].pages()[0]
const result = await page.evaluate(process.argv[2])
console.log(JSON.stringify(result, null, 1))
await browser.close().catch(() => {})
process.exit(0)
