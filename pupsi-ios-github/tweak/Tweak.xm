// Pupsi v1 - jailbreak tweak: injects the shared engine into the Chess.com iOS app.
// Runs in the Chess.com process, not a wrapper. Requires a jailbroken iPhone
// (rootless Dopamine/serotonin or rootful) and Theos.
#import <WebKit/WebKit.h>
#import "PupsiSchemeHandler.h"

static NSString *PupsiFile(NSString *name, NSString *ext) {
    NSString *root = [PupsiSchemeHandler resourcesRoot];
    NSString *path = [[root stringByAppendingPathComponent:name] stringByAppendingPathExtension:ext];
    return [[NSFileManager defaultManager] fileExistsAtPath:path] ? path : nil;
}

static NSString *PupsiSource(NSString *name, NSString *ext) {
    NSString *path = PupsiFile(name, ext);
    return path ? [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] : nil;
}

static NSString *PupsiJSString(NSString *raw) {
    NSMutableString *out = [NSMutableString stringWithString:@"\""];
    for (NSUInteger i = 0; i < raw.length; i++) {
        unichar c = [raw characterAtIndex:i];
        switch (c) {
            case '\\': [out appendString:@"\\\\"]; break;
            case '"':  [out appendString:@"\\\""]; break;
            case '\n': [out appendString:@"\\n"]; break;
            case '\r': [out appendString:@"\\r"]; break;
            case '\t': [out appendString:@"\\t"]; break;
            default:   [out appendFormat:@"%C", c]; break;
        }
    }
    [out appendString:@"\""];
    return out;
}

%hook WKWebView

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    WKWebViewConfiguration *cfg = configuration ?: [[WKWebViewConfiguration alloc] init];
    WKUserContentController *uc = cfg.userContentController ?: [[WKUserContentController alloc] init];

    [cfg setURLSchemeHandler:[[PupsiSchemeHandler alloc] init] forURLScheme:@"pupsi"];

    NSString *shim = PupsiSource(@"pupsi-shim", @"js");
    NSString *engine = PupsiSource(@"content", @"js");
    NSString *css = PupsiSource(@"styles", @"css");

    if (shim) {
        [uc addUserScript:[[WKUserScript alloc] initWithSource:shim
                                                 injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                              forMainFrameOnly:NO]];
    }
    if (css) {
        NSString *js = [NSString stringWithFormat:
            @"(function(){var s=document.createElement('style');s.id='pupsi-styles';s.textContent=%@;"
            @"(document.head||document.documentElement).appendChild(s)})();", PupsiJSString(css)];
        [uc addUserScript:[[WKUserScript alloc] initWithSource:js
                                                 injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                              forMainFrameOnly:YES]];
    }
    if (engine) {
        [uc addUserScript:[[WKUserScript alloc] initWithSource:engine
                                                 injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                              forMainFrameOnly:YES]];
    }

    cfg.userContentController = uc;
    return %orig(frame, cfg);
}

%end
