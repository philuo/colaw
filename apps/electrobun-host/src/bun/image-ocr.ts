/**
 * On-image text recognition through Apple's Vision framework.
 *
 * The host never ships a native helper: `/usr/bin/osascript` runs an
 * AppleScriptObjC snippet that drives VNRecognizeTextRequest directly
 * (accurate level, Simplified Chinese + English). The JXA bridge that would
 * be the tidier embed is broken on this OS generation — NSObject-inherited
 * class methods such as alloc/new cannot be invoked — while AppleScriptObjC
 * remains maintained. The script rides stdin and the image path arrives as
 * argv, so no shell interpolation ever sees it.
 */
import { spawn } from 'node:child_process'

/** One recognized text block; normalized [0,1] in image coordinates, top-left origin. */
export interface ImageOcrItem {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Either the recognized items or a printable failure. */
export type ImageOcrResult = { readonly items: readonly ImageOcrItem[] } | { readonly error: string }

const OCR_SCRIPT = `use framework "Vision"
use framework "Foundation"
use scripting additions
on run argv
	set imgPath to item 1 of argv
	set theURL to current application's NSURL's fileURLWithPath:imgPath
	set theHandler to current application's VNImageRequestHandler's alloc()'s initWithURL:theURL options:(missing value)
	set theRequest to current application's VNRecognizeTextRequest's alloc()'s init()
	theRequest's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)
	theRequest's setUsesLanguageCorrection:true
	theRequest's setRecognitionLanguages:{"zh-Hans", "en-US"}
	set ok to theHandler's performRequests:{theRequest} |error|:(missing value)
	if (ok as boolean) is false then return "{}"
	set theResults to theRequest's results()
	set outArray to current application's NSMutableArray's array()
	repeat with anObs in theResults
		set theBox to ((anObs's boundingBox()) as list)
		set theCands to (anObs's topCandidates:1)
		if ((theCands's |count|()) as integer) > 0 then
			set theText to ((theCands's objectAtIndex:0)'s |string|())
			set {rx, ry} to (item 1 of theBox) as list
			set {rw, rh} to (item 2 of theBox) as list
			set aDict to current application's NSMutableDictionary's dictionary()
			(aDict's setObject:theText forKey:"text")
			(aDict's setObject:(rx as real) forKey:"x")
			(aDict's setObject:(ry as real) forKey:"y")
			(aDict's setObject:(rw as real) forKey:"w")
			(aDict's setObject:(rh as real) forKey:"h")
			(outArray's addObject:aDict)
		end if
	end repeat
	set jsonData to current application's NSJSONSerialization's dataWithJSONObject:outArray options:0 |error|:(missing value)
	set outString to current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)
	return outString as text
end run
`

/** Hard ceiling: a stuck recognition must not pin the command channel. */
const OCR_TIMEOUT_MS = 30_000

/**
 * Recognize text in one local image file.
 * @param path - absolute path to the image the preview is showing.
 * @returns the recognized blocks (already flipped to top-left origin), or an error.
 */
export function runImageOcr(path: string): Promise<ImageOcrResult> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-', path], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let settled = false
    const settle = (result: ImageOcrResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle({ error: 'recognition timed out' })
    }, OCR_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.on('error', (error) => { settle({ error: String(error) }) })
    child.on('close', (code) => {
      if (code !== 0) {
        settle({ error: 'recognition failed' })
        return
      }
      try {
        const raw = JSON.parse(stdout) as Array<{ text?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }>
        if (!Array.isArray(raw)) {
          settle({ error: 'recognition returned no result' })
          return
        }
        const items: ImageOcrItem[] = []
        for (const entry of raw) {
          if (typeof entry.text !== 'string') continue
          const x = Number(entry.x), y = Number(entry.y), w = Number(entry.w), h = Number(entry.h)
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
          // Vision reports bottom-left origin boxes; the overlay wants top-left.
          items.push({ text: entry.text, x, y: 1 - y - h, w, h })
        }
        settle({ items })
      } catch {
        settle({ error: 'recognition output was unreadable' })
      }
    })
    child.stdin.write(OCR_SCRIPT)
    child.stdin.end()
  })
}
