#import <AppKit/AppKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "screen.h"
#include <string.h>

int mr_screen_access(void) { return CGPreflightScreenCaptureAccess() ? 1 : 0; }
int mr_screen_request(void) { return CGRequestScreenCaptureAccess() ? 1 : 0; }

static void fail(char *err, size_t len, NSString *msg) {
    if (err && len) strlcpy(err, msg.UTF8String, len);
}

@interface MrScreenOut : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) MrScreenFrame cb;
@property(nonatomic) void *ctx;
@end

@implementation MrScreenOut
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sb ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sb)) return;
    // only complete frames (idle and blank ones carry no image)
    NSArray *att = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sb, NO);
    NSNumber *status = att.firstObject[SCStreamFrameInfoStatus];
    if (status && status.integerValue != SCFrameStatusComplete) return;
    CVImageBufferRef img = CMSampleBufferGetImageBuffer(sb);
    if (!img) return;
    CVPixelBufferLockBaseAddress(img, kCVPixelBufferLock_ReadOnly);
    const uint8_t *base = CVPixelBufferGetBaseAddress(img);
    if (base) _cb(base, (uint32_t)CVPixelBufferGetWidth(img), (uint32_t)CVPixelBufferGetHeight(img), (uint32_t)CVPixelBufferGetBytesPerRow(img), _ctx);
    CVPixelBufferUnlockBaseAddress(img, kCVPixelBufferLock_ReadOnly);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    NSLog(@"MusicRemover: the screen capture stopped: %@", error.localizedDescription);
}
@end

struct MrScreen {
    void *stream;  // SCStream, retained
    void *out;     // MrScreenOut, retained
    void *queue;   // dispatch_queue_t, retained
};

MrScreen *mr_screen_start(MrScreenFrame cb, void *ctx, uint32_t max_width, double interval_s, char *err, size_t err_len) {
    __block SCShareableContent *content = nil;
    __block NSError *cerr = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *c, NSError *e) {
        content = c;
        cerr = e;
        dispatch_semaphore_signal(sem);
    }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0 || !content) {
        fail(err, err_len, cerr ? cerr.localizedDescription : @"no answer from ScreenCaptureKit (screen recording not allowed?)");
        return NULL;
    }
    SCDisplay *display = nil;
    for (SCDisplay *d in content.displays)
        if (d.displayID == CGMainDisplayID()) display = d;
    if (!display) display = content.displays.firstObject;
    if (!display) {
        fail(err, err_len, @"no display");
        return NULL;
    }
    // this process's own windows (the overlay) are not captured
    NSMutableArray<SCRunningApplication *> *own = [NSMutableArray array];
    for (SCRunningApplication *a in content.applications)
        if (a.processID == getpid()) [own addObject:a];
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingApplications:own exceptingWindows:@[]];

    SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
    uint32_t w = MIN(max_width, (uint32_t)display.width * 2);
    cfg.width = w;
    cfg.height = (size_t)((double)w * (double)display.height / (double)display.width);
    cfg.pixelFormat = kCVPixelFormatType_32BGRA;
    cfg.minimumFrameInterval = CMTimeMakeWithSeconds(interval_s, 1000);
    cfg.queueDepth = 3;
    cfg.showsCursor = NO;

    MrScreenOut *out = [[MrScreenOut alloc] init];
    out.cb = cb;
    out.ctx = ctx;
    dispatch_queue_t q = dispatch_queue_create("mr.screen", DISPATCH_QUEUE_SERIAL);
    SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:cfg delegate:out];
    NSError *aerr = nil;
    if (![stream addStreamOutput:out type:SCStreamOutputTypeScreen sampleHandlerQueue:q error:&aerr]) {
        fail(err, err_len, aerr.localizedDescription);
        return NULL;
    }
    __block NSError *serr = nil;
    [stream startCaptureWithCompletionHandler:^(NSError *e) {
        serr = e;
        dispatch_semaphore_signal(sem);
    }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0 || serr) {
        fail(err, err_len, serr ? serr.localizedDescription : @"the screen capture did not start");
        return NULL;
    }
    MrScreen *s = calloc(1, sizeof(MrScreen));
    s->stream = (void *)CFBridgingRetain(stream);
    s->out = (void *)CFBridgingRetain(out);
    s->queue = (void *)CFBridgingRetain(q);
    return s;
}

void mr_screen_stop(MrScreen *s) {
    if (!s) return;
    SCStream *stream = (SCStream *)CFBridgingRelease(s->stream);
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError *e) { dispatch_semaphore_signal(sem); }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    CFBridgingRelease(s->out);
    CFBridgingRelease(s->queue);
    free(s);
}

// ── the overlay: one transparent click-through window over the main display, with a blurred patch per region.
// The blur is the system's own (a behind-window visual effect), done by the window server, so it follows the
// picture without us drawing anything and our capture never has to see it.

static NSWindow *gWindow;
static NSMutableArray<NSVisualEffectView *> *gPatches;

static void applyRects(NSArray<NSValue *> *rects) {
    if (rects.count == 0) {
        [gWindow orderOut:nil];
        return;
    }
    NSScreen *screen = NSScreen.screens.firstObject;
    if (!screen) return;
    if (!gWindow) {
        gWindow = [[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        gWindow.opaque = NO;
        gWindow.backgroundColor = NSColor.clearColor;
        gWindow.hasShadow = NO;
        gWindow.ignoresMouseEvents = YES;
        gWindow.level = NSScreenSaverWindowLevel;
        // not in screenshots or captures either (MR_OVERLAY_VISIBLE=1 lets a screenshot show it, for checking)
        gWindow.sharingType = getenv("MR_OVERLAY_VISIBLE") ? NSWindowSharingReadOnly : NSWindowSharingNone;
        gWindow.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
        gWindow.releasedWhenClosed = NO;
        gPatches = [NSMutableArray array];
    }
    [gWindow setFrame:screen.frame display:NO];
    NSView *root = gWindow.contentView;
    CGFloat W = root.bounds.size.width, H = root.bounds.size.height;
    while (gPatches.count < rects.count) {
        NSVisualEffectView *v = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
        v.material = NSVisualEffectMaterialHUDWindow;
        v.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        v.state = NSVisualEffectStateActive;
        v.wantsLayer = YES;
        v.layer.cornerRadius = 12;
        v.layer.masksToBounds = YES;
        // a dark veil on top of the blur: a blur alone leaves large shapes recognisable
        NSView *veil = [[NSView alloc] initWithFrame:NSZeroRect];
        veil.wantsLayer = YES;
        veil.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:0.5].CGColor;
        veil.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [v addSubview:veil];
        [root addSubview:v];
        [gPatches addObject:v];
    }
    for (NSUInteger i = 0; i < gPatches.count; i++) {
        NSVisualEffectView *v = gPatches[i];
        if (i >= rects.count) {
            v.hidden = YES;
            continue;
        }
        CGRect r = rects[i].rectValue;  // fractions, origin top-left
        v.hidden = NO;
        v.frame = NSMakeRect(r.origin.x * W, H - (r.origin.y + r.size.height) * H, r.size.width * W, r.size.height * H);
        v.subviews.firstObject.frame = v.bounds;
    }
    [gWindow orderFrontRegardless];
}

void mr_overlay_set(const float *rects, int n) {
    NSMutableArray<NSValue *> *list = [NSMutableArray arrayWithCapacity:n];
    for (int i = 0; i < n; i++) [list addObject:[NSValue valueWithRect:NSMakeRect(rects[i * 4], rects[i * 4 + 1], rects[i * 4 + 2], rects[i * 4 + 3])]];
    dispatch_async(dispatch_get_main_queue(), ^{ applyRects(list); });
}
