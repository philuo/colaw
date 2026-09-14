/** 最小 FFI 探针：隔离 PixelWidth 读取失败的原因 */
import { dlopen, ptr } from 'bun:ffi'
import sharp from 'sharp'

const CF = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const IO = '/System/Library/Frameworks/ImageIO.framework/ImageIO'

const png = new Uint8Array(await sharp({
  create: { width: 64, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } },
}).png().toBuffer())

const cf = dlopen(CF, {
  CFDataCreate: { args: ['ptr', 'ptr', 'i64'], returns: 'ptr' },
  CFStringCreateWithCString: { args: ['ptr', 'cstring', 'u32'], returns: 'ptr' },
  CFRelease: { args: ['ptr'], returns: 'void' },
}).symbols
const io = dlopen(IO, {
  CGImageSourceCreateWithData: { args: ['ptr', 'ptr'], returns: 'ptr' },
  CGImageSourceCopyPropertiesAtIndex: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
}).symbols

const cfData = cf.CFDataCreate(null, ptr(png), png.byteLength)
console.log('1. CFDataCreate:', cfData !== null ? '✓' : '❌')

const source = io.CGImageSourceCreateWithData(cfData, 0)
console.log('2. CGImageSourceCreateWithData:', source !== null ? '✓' : '❌')

const key = cf.CFStringCreateWithCString(null, 'PixelWidth', 0x08000100)
const props = io.CGImageSourceCopyPropertiesAtIndex(source, 0, 0)
console.log('3. CopyPropertiesAtIndex:', props !== null ? '✓' : '❌')

const value = cf.CFDictionaryGetValue(props, key)
console.log('4. CFDictionaryGetValue(PixelWidth):', value !== null ? `✓ ptr=${value}` : '❌ NULL')

if (value !== null) {
  const out = new Uint8Array(8)
  const cfNum = dlopen(CF, { CFNumberGetValue: { args: ['ptr', 'i32', 'ptr'], returns: 'u8' } }).symbols
  const ok = cfNum.CFNumberGetValue(value, 4, ptr(out))
  console.log('5. CFNumberGetValue:', ok ? '✓' : '❌', 'value:', new DataView(out.buffer).getBigInt64(0))
}

cf.CFRelease(key); cf.CFRelease(props); cf.CFRelease(source); cf.CFRelease(cfData)
