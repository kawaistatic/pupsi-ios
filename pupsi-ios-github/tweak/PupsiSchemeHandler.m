// pupsi:// URL scheme handler for the jailbreak tweak
#import "PupsiSchemeHandler.h"
#import <Foundation/Foundation.h>

@implementation PupsiSchemeHandler

+ (NSString *)resourcesRoot {
    NSArray *roots = @[
        @"/var/jb/Library/Application Support/Pupsi",
        @"/Library/Application Support/Pupsi"
    ];
    for (NSString *root in roots) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:root]) return root;
    }
    return roots[0];
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *path = [url.path stringByTrimmingCharactersInSet:
                      [NSCharacterSet characterSetWithCharactersInString:@"/"]];
    NSString *root = [[self class] resourcesRoot];
    NSURL *file = [[NSURL fileURLWithPath:root] URLByAppendingPathComponent:path];
    NSString *standardized = file.standardizedFileURL.path;
    if (![standardized hasPrefix:[root stringByAppendingString:@"/"]]) {
        [self fail:task status:403]; return;
    }
    NSData *data = [NSData dataWithContentsOfURL:file];
    if (!data) { [self fail:task status:404]; return; }

    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:url statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{
            @"Content-Type": [self mimeForExtension:file.pathExtension],
            @"Access-Control-Allow-Origin": @"*",
            @"Cache-Control": @"no-store"
        }];
    [task didReceiveResponse:response];
    [task didReceiveData:data];
    [task didFinish];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}

- (void)fail:(id<WKURLSchemeTask>)task status:(NSInteger)status {
    NSURL *url = task.request.URL ?: [NSURL URLWithString:@"pupsi://local/"];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:url statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:nil];
    [task didReceiveResponse:response];
    [task didFinish];
}

- (NSString *)mimeForExtension:(NSString *)ext {
    NSDictionary *map = @{
        @"js": @"application/javascript; charset=utf-8",
        @"wasm": @"application/wasm",
        @"css": @"text/css; charset=utf-8",
        @"html": @"text/html; charset=utf-8",
        @"png": @"image/png",
        @"svg": @"image/svg+xml"
    };
    return map[ext.lowercaseString] ?: @"application/octet-stream";
}

@end
