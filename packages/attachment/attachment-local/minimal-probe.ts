/** 完整符号声明的最小探针：逐步打印 PixelWidth 读取链路上每个值的 typeof */
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
  CFStringGetCString: { args: ['ptr', 'ptr', 'i64', 'u32'], returns: 'u8' },
  CFDictionaryGetValue: { args: ['ptr', 'ptr'], returns: 'ptr' },
  CFNumberGetValue: { args: ['ptr', 'i32', 'ptr'], returns: 'u8' },
  CFBooleanGetValue: { args: ['ptr'], returns: 'u8' },
  CFGetTypeID: { args: ['ptr'], returns: 'i64' },
  CFStringGetTypeID: { args: [], returns: 'i64' },
  CFNumberGetTypeID: { args: [], returns: 'i64' },
  CFBooleanGetTypeID: { args: [], returns: 'i64' },
  CFRelease: { args: ['ptr'], returns: 'void' },
}).symbols
const io = dlopen(IO, {
  CGImageSourceCreateWithData: { args: ['ptr', 'ptr'], returns: 'ptr' },
  CGImageSourceCopyPropertiesAtIndex: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
}).symbols

const cfData = cf.CFDataCreate(null, ptr(png), png.byteLength)
console.log('1. CFDataCreate typeof:', typeof cfData, 'value:', String(cfData))

const source = io.CGImageSourceCreateWithData(cfData, 0)
console.log('2. source typeof:', typeof source)

const props = io.CGImageSourceCopyPropertiesAtIndex(source, 0, 0)
console.log('3. props typeof:', typeof props)

const key = cf.CFStringCreateWithCString(null, 'PixelWidth', 0x08000100)
console.log('4. key typeof:', typeof key)

const value = cf.CFDictionaryGetValue(props, key)
console.log('5. value typeof:', typeof value, 'value:', String(value))

if (value !== null && value !== undefined) {
  const typeId = cf.CFGetTypeID(value)
  console.log('6. value CFTypeID:', typeId, '(string=', cf.CFStringGetTypeID(), 'number=', cf.CFNumberGetTypeID(), 'boolean=', cf.CFBooleanGetTypeID(), ')')
  if (typeId === cf.CFNumberGetTypeID()) {
    const out = new BigInt64Array(1)
    const ok = cf.CFNumberGetValue(value, 4, ptr(out))
    console.log('7. CFNumberGetValue:', ok, '→', Number(out[0]))
  }
}

// HasAlpha（boolean 路径）同链路对照
const alphaKey = cf.CFStringCreateWithCString(null, 'HasAlpha', 0x08000100)
const alphaValue = cf.CFDictionaryGetValue(props, alphaKey)
console.log('8. HasAlpha value typeof:', typeof alphaValue, 'value:', String(alphaValue))
if (alphaValue !== null && alphaValue !== undefined) {
  console.log('9. HasAlpha CFTypeID:', cf.CFGetTypeID(alphaValue), 'CFBooleanGetValue:', cf.CFBooleanGetValue(alphaValue))
}

cf.CFRelease(key); cf.CFRelease(alphaKey); cf.CFRelease(props); cf.CFRelease(source); cf.CFRelease(cfData)
