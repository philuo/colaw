// Colaw WKWebView 60fps-cap unlock (swizzle dylib).
//
// On macOS 13-15 WKWebView caps requestAnimationFrame near 60fps via the
// WebKit preference `PreferPageRenderingUpdatesNear60FPSEnabled` (default
// true). The ONLY effective way to disable it — machine-verified 2026-09-14
// on macOS 15.6.1 with fps probes (see repo-root webveiew-settings.md §11) —
// is `_setEnabled:forFeature:NO` on the WKWebViewConfiguration's
// preferences BEFORE `-[WKWebView initWithFrame:configuration:]` runs;
// post-creation toggles are ignored even across fresh navigations, and
// NSUserDefaults is never consulted for identifier-less configurations.
//
// This dylib is loaded through an injected LC_LOAD_DYLIB into
// libNativeWrapper.dylib — i.e. exactly in the process that creates
// windows — and swizzles that initializer so every webview Electrobun ever
// creates gets an unlocked configuration, no Electrobun source changes.
//
// No-op on macOS 26+ (Apple removed the cap) and when COLAW_WEBVIEW_UNLOCK=0.
// Set COLAW_WEBVIEW_UNLOCK_DEBUG=1 to log the swizzle to the unified log.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <stdlib.h>

static id (*origInitWithFrameConfiguration)(id, SEL, CGRect, WKWebViewConfiguration *);

static void unlockConfiguration(WKWebViewConfiguration *configuration) {
    if (configuration == nil) return;
    @try {
        Class preferencesClass = NSClassFromString(@"WKPreferences");
        SEL featuresSelector = NSSelectorFromString(@"_features");
        SEL keySelector = NSSelectorFromString(@"key");
        SEL setEnabledSelector = NSSelectorFromString(@"_setEnabled:forFeature:");
        if (preferencesClass == nil
            || ![preferencesClass respondsToSelector:featuresSelector]
            || ![configuration.preferences respondsToSelector:setEnabledSelector]) {
            return;
        }
        NSArray *features = ((NSArray *(*)(id, SEL))objc_msgSend)((id)preferencesClass, featuresSelector);
        for (id feature in features) {
            NSString *key = ((NSString *(*)(id, SEL))objc_msgSend)(feature, keySelector);
            if ([key isEqualToString:@"PreferPageRenderingUpdatesNear60FPSEnabled"]) {
                ((void (*)(id, SEL, BOOL, id))objc_msgSend)(
                    configuration.preferences, setEnabledSelector, NO, feature);
                break;
            }
        }
    } @catch (NSException *exception) {
        NSLog(@"[colaw-webview-unlock] toggle failed: %@", exception);
    }
}

static id hookedInitWithFrameConfiguration(
    id self, SEL _cmd, CGRect frame, WKWebViewConfiguration *configuration) {
    unlockConfiguration(configuration);
    return origInitWithFrameConfiguration(self, _cmd, frame, configuration);
}

__attribute__((constructor)) static void colawWebviewUnlockLoad(void) {
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    if (version.majorVersion >= 26) return; // the cap is gone; nothing to do
    const char *override = getenv("COLAW_WEBVIEW_UNLOCK");
    if (override != NULL && strcmp(override, "0") == 0) return;

    Method method = class_getInstanceMethod(
        [WKWebView class], NSSelectorFromString(@"initWithFrame:configuration:"));
    if (method == NULL) {
        NSLog(@"[colaw-webview-unlock] initWithFrame:configuration: not found; unlock inactive");
        return;
    }
    origInitWithFrameConfiguration = (void *)method_getImplementation(method);
    method_setImplementation(method, (IMP)hookedInitWithFrameConfiguration);
    if (getenv("COLAW_WEBVIEW_UNLOCK_DEBUG") != NULL) {
        NSLog(@"[colaw-webview-unlock] swizzled -[WKWebView initWithFrame:configuration:]");
    }
}
