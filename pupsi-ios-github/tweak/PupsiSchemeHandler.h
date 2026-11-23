// pupsi:// URL scheme handler for the jailbreak tweak
#import <WebKit/WebKit.h>

@interface PupsiSchemeHandler : NSObject <WKURLSchemeHandler>
+ (NSString *)resourcesRoot;
@end
