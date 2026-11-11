// "Hide in a window": a delayed, blurred copy of one window laid exactly over it. See window.h and screen.rs.
#import <AppKit/AppKit.h>
#import <Accelerate/Accelerate.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "window.h"
#include <string.h>

static double hostNow(void) { return CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())); }
static void setErr(char *err, size_t len, NSString *msg) {
    if (err && len) strlcpy(err, msg.UTF8String, len);
}

// ── the list of windows to choose from

int mr_windows(MrWindowInfo *out, int max) {
    __block SCShareableContent *content = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *c, NSError *e) {
        content = c;
        dispatch_semaphore_signal(sem);
    }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0 || !content) return -1;
    int n = 0;
    for (SCWindow *w in content.windows) {
        if (n >= max) break;
        if (w.windowLayer != 0 || !w.onScreen || w.frame.size.width < 200 || w.frame.size.height < 150) continue;
        if (!w.owningApplication || w.owningApplication.processID == getpid()) continue;
        MrWindowInfo *o = &out[n++];
        o->id = (uint32_t)w.windowID;
        o->width = (uint32_t)w.frame.size.width;
        o->height = (uint32_t)w.frame.size.height;
        strlcpy(o->app, (w.owningApplication.applicationName ?: @"").UTF8String, sizeof(o->app));
        strlcpy(o->title, (w.title ?: @"").UTF8String, sizeof(o->title));
    }
    return n;
}

// ── one captured frame, kept for the delay

@interface MrFrame : NSObject
@property(nonatomic) double pts;
@property(nonatomic) CVPixelBufferRef pb;  // retained
@end
@implementation MrFrame
- (void)dealloc { if (_pb) CVPixelBufferRelease(_pb); }
@end

@interface MrRect : NSObject
@property(nonatomic) CGRect r;
@end
@implementation MrRect
@end

@interface MrSpan : NSObject  // regions to blur on the frames of [from, to]
@property(nonatomic) double from, to;
@property(nonatomic, strong) NSArray<NSValue *> *rects;
@end
@implementation MrSpan
@end

@interface MrWin : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) uint32_t windowID;
@property(nonatomic) MrWindowFrame cb;
@property(nonatomic) void *ctx;
@property(nonatomic) double delay;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) CIContext *ci;
@property(nonatomic) CGColorSpaceRef cs;
// capture side
@property(nonatomic) CVPixelBufferPoolRef inPool;
@property(nonatomic) size_t poolW, poolH;
@property(nonatomic) double lastDetect;
@property(nonatomic) volatile int stopped;
@property(nonatomic) volatile int failed;
// shared
@property(nonatomic, strong) NSMutableArray<MrFrame *> *ring;
@property(nonatomic, strong) NSMutableArray<MrSpan *> *spans;
@property(nonatomic, strong) NSLock *lock;
// main-thread side
@property(nonatomic, strong) NSWindow *replica;
@property(nonatomic, strong) CALayer *layer;
@property(nonatomic, strong) id link;
@property(nonatomic, strong) MrFrame *shown;
@property(nonatomic, copy) NSString *shownSig;
@property(nonatomic) CVPixelBufferPoolRef outPool;
@property(nonatomic) size_t outW, outH;
@property(nonatomic) CVPixelBufferRef outBuf;  // the buffer on screen (retained)
@property(nonatomic) CGSize configured;
@property(nonatomic) double resizeSince;
@end

static CVPixelBufferPoolRef makePool(size_t w, size_t h) {
    NSDictionary *attrs = @{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferWidthKey: @(w),
        (id)kCVPixelBufferHeightKey: @(h),
        (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
        (id)kCVPixelBufferMetalCompatibilityKey: @YES,
    };
    CVPixelBufferPoolRef pool = NULL;
    CVPixelBufferPoolCreate(NULL, NULL, (__bridge CFDictionaryRef)attrs, &pool);
    return pool;
}

@implementation MrWin

// ── capture queue: copy every frame into the ring, hand a downscaled one to the detector now and then
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sb ofType:(SCStreamOutputType)type {
    if (self.stopped || type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sb)) return;
    NSArray *att = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sb, NO);
    NSNumber *status = att.firstObject[SCStreamFrameInfoStatus];
    if (status && status.integerValue != SCFrameStatusComplete) return;
    CVImageBufferRef img = CMSampleBufferGetImageBuffer(sb);
    if (!img) return;
    double pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb));
    size_t W = CVPixelBufferGetWidth(img), H = CVPixelBufferGetHeight(img);
    if (!self.inPool || W != self.poolW || H != self.poolH) {
        if (self.inPool) CVPixelBufferPoolRelease(self.inPool);
        self.inPool = makePool(W, H);
        self.poolW = W;
        self.poolH = H;
    }
    CVPixelBufferRef copy = NULL;
    if (CVPixelBufferPoolCreatePixelBuffer(NULL, self.inPool, &copy) == kCVReturnSuccess) {
        [self.ci render:[CIImage imageWithCVPixelBuffer:img] toCVPixelBuffer:copy bounds:CGRectMake(0, 0, W, H) colorSpace:self.cs];
        MrFrame *f = [[MrFrame alloc] init];
        f.pts = pts;
        f.pb = copy;  // owns the reference from Create
        [self.lock lock];
        [self.ring addObject:f];
        double keep = hostNow() - self.delay - 0.6;
        while (self.ring.count > 2 && self.ring.firstObject.pts < keep) [self.ring removeObjectAtIndex:0];
        [self.lock unlock];
    }
    // the detector looks at about five frames a second, at most 1600 px wide
    if (pts - self.lastDetect >= 0.18) {
        self.lastDetect = pts;
        CVPixelBufferLockBaseAddress(img, kCVPixelBufferLock_ReadOnly);
        const uint8_t *base = CVPixelBufferGetBaseAddress(img);
        size_t stride = CVPixelBufferGetBytesPerRow(img);
        if (base && W <= 1600) {
            self.cb(base, (uint32_t)W, (uint32_t)H, (uint32_t)stride, pts, self.ctx);
        } else if (base) {
            size_t w = 1600, h = (size_t)((double)H * 1600.0 / (double)W);
            vImage_Buffer src = {(void *)base, H, W, stride}, dst;
            if (vImageBuffer_Init(&dst, h, w, 32, kvImageNoFlags) == kvImageNoError) {
                vImageScale_ARGB8888(&src, &dst, NULL, kvImageHighQualityResampling);
                self.cb(dst.data, (uint32_t)w, (uint32_t)h, (uint32_t)dst.rowBytes, pts, self.ctx);
                free(dst.data);
            }
        }
        CVPixelBufferUnlockBaseAddress(img, kCVPixelBufferLock_ReadOnly);
    }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (!self.stopped) {
        NSLog(@"MusicRemover: the window capture stopped: %@", error.localizedDescription);
        self.failed = 1;
    }
}

// ── main thread: follow the real window, show the frame of `delay` seconds ago with the blur on it

- (void)setUpReplica {
    self.replica = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    self.replica.opaque = NO;
    self.replica.backgroundColor = NSColor.clearColor;
    self.replica.hasShadow = NO;
    self.replica.ignoresMouseEvents = YES;
    // a window that is not fully opaque does not count as covering the real one: Chrome pauses its video in a
    // window it thinks is hidden, and AppKit calls a window hidden when other windows cover it completely
    self.replica.alphaValue = 0.99;
    self.replica.sharingType = getenv("MR_OVERLAY_VISIBLE") ? NSWindowSharingReadOnly : NSWindowSharingNone;
    self.replica.releasedWhenClosed = NO;
    self.replica.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
    NSView *v = self.replica.contentView;
    v.wantsLayer = YES;
    self.layer = [CALayer layer];
    self.layer.contentsGravity = kCAGravityResize;
    self.layer.magnificationFilter = kCAFilterLinear;
    self.layer.frame = v.bounds;
    self.layer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    [v.layer addSublayer:self.layer];
    NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    if (@available(macOS 14.0, *)) {
        CADisplayLink *l = [screen displayLinkWithTarget:self selector:@selector(tick:)];
        [l addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
        self.link = l;
    } else {
        self.link = [NSTimer scheduledTimerWithTimeInterval:1.0 / 60 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
    }
}

- (NSArray<NSValue *> *)rectsAt:(double)t {
    NSMutableArray *out = [NSMutableArray array];
    for (MrSpan *s in self.spans)
        if (t >= s.from && t <= s.to) [out addObjectsFromArray:s.rects];
    return out;
}

- (void)tick:(id)sender {
    if (self.stopped) return;
    // where the real window is now, and what is above it
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSDictionary *real = nil;
    NSInteger realIdx = -1, repIdx = -1, i = 0;
    NSInteger repID = self.replica.windowNumber;
    for (NSDictionary *d in list) {
        NSInteger num = [d[(id)kCGWindowNumber] integerValue];
        if (num == self.windowID) { real = d; realIdx = i; }
        if (num == repID) repIdx = i;
        i++;
    }
    if (!real) {
        [self.replica orderOut:nil];  // minimised or on another Space
        return;
    }
    CGRect b;
    CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)real[(id)kCGWindowBounds], &b);
    CGFloat primaryH = NSScreen.screens.firstObject.frame.size.height;
    NSRect want = NSMakeRect(b.origin.x, primaryH - b.origin.y - b.size.height, b.size.width, b.size.height);
    if (!NSEqualRects(self.replica.frame, want)) [self.replica setFrame:want display:NO];
    // directly above the real window (list is front to back, so the replica must sit just before it)
    if (repIdx < 0 || repIdx != realIdx - 1) [self.replica orderWindow:NSWindowAbove relativeTo:self.windowID];

    // the real window was resized: capture at the new size
    CGSize cur = b.size;
    if (fabs(cur.width - self.configured.width) > 1 || fabs(cur.height - self.configured.height) > 1) {
        if (self.resizeSince == 0) self.resizeSince = hostNow();
        if (hostNow() - self.resizeSince > 0.25) {
            self.resizeSince = 0;
            self.configured = cur;
            [self.stream updateConfiguration:[MrWin configFor:cur] completionHandler:^(NSError *e) {}];
        }
    } else {
        self.resizeSince = 0;
    }

    // the frame of `delay` ago
    double target = hostNow() - self.delay;
    [self.lock lock];
    MrFrame *pick = nil;
    for (MrFrame *f in self.ring) {
        if (f.pts <= target) pick = f; else break;
    }
    NSArray<NSValue *> *rects = [self rectsAt:target];
    for (NSInteger k = (NSInteger)self.spans.count - 1; k >= 0; k--)
        if (self.spans[k].to < target - 1.0) [self.spans removeObjectAtIndex:k];
    [self.lock unlock];
    if (!pick) return;
    NSMutableString *sig = [NSMutableString stringWithFormat:@"%p", pick];
    for (NSValue *v in rects) { CGRect r = v.rectValue; [sig appendFormat:@"|%.3f,%.3f,%.3f,%.3f", r.origin.x, r.origin.y, r.size.width, r.size.height]; }
    if ([sig isEqualToString:self.shownSig]) return;
    self.shownSig = sig;
    [self show:pick rects:rects];
}

- (void)show:(MrFrame *)f rects:(NSArray<NSValue *> *)rects {
    CVPixelBufferRef src = f.pb;
    if (rects.count == 0) {
        self.shown = f;
        [self put:src retain:YES];
        return;
    }
    size_t W = CVPixelBufferGetWidth(src), H = CVPixelBufferGetHeight(src);
    if (!self.outPool || W != self.outW || H != self.outH) {
        if (self.outPool) CVPixelBufferPoolRelease(self.outPool);
        self.outPool = makePool(W, H);
        self.outW = W;
        self.outH = H;
    }
    CVPixelBufferRef out = NULL;
    if (CVPixelBufferPoolCreatePixelBuffer(NULL, self.outPool, &out) != kCVReturnSuccess) return;
    CIImage *base = [CIImage imageWithCVPixelBuffer:src];
    CIImage *result = base;
    CGFloat sigma = MAX(14.0, (CGFloat)W * 0.02);
    CIImage *soft = [[base imageByClampingToExtent] imageByApplyingGaussianBlurWithSigma:sigma];
    for (NSValue *v in rects) {
        CGRect r = v.rectValue;  // fractions, origin top-left
        CGRect px = CGRectMake(r.origin.x * W, (1.0 - r.origin.y - r.size.height) * H, r.size.width * W, r.size.height * H);
        px = CGRectIntersection(px, CGRectMake(0, 0, W, H));
        if (CGRectIsNull(px) || px.size.width < 1 || px.size.height < 1) continue;
        CIImage *patch = [soft imageByCroppingToRect:px];
        // darken a little: a blur alone leaves large shapes recognisable
        CIImage *dark = [patch imageByApplyingFilter:@"CIColorControls" withInputParameters:@{kCIInputBrightnessKey: @(-0.28)}];
        result = [dark imageByCompositingOverImage:result];
    }
    [self.ci render:result toCVPixelBuffer:out bounds:CGRectMake(0, 0, W, H) colorSpace:self.cs];
    self.shown = f;
    [self put:out retain:NO];
}

- (void)put:(CVPixelBufferRef)pb retain:(BOOL)retain {
    IOSurfaceRef surf = CVPixelBufferGetIOSurface(pb);
    if (!surf) return;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.layer.contents = (__bridge id)surf;
    [CATransaction commit];
    if (retain) CVPixelBufferRetain(pb);
    if (self.outBuf) CVPixelBufferRelease(self.outBuf);
    self.outBuf = pb;  // keeps the surface alive while it is on screen
    if (!self.replica.visible) [self.replica orderFrontRegardless];
}

+ (SCStreamConfiguration *)configFor:(CGSize)size {
    CGFloat scale = NSScreen.mainScreen.backingScaleFactor ?: 2.0;
    CGFloat w = size.width * scale, h = size.height * scale;
    if (w > 1920) { h *= 1920 / w; w = 1920; }
    SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
    cfg.width = (size_t)MAX(w, 16);
    cfg.height = (size_t)MAX(h, 16);
    cfg.pixelFormat = kCVPixelFormatType_32BGRA;
    cfg.minimumFrameInterval = CMTimeMake(1, 30);
    cfg.queueDepth = 6;
    cfg.showsCursor = NO;
    cfg.colorSpaceName = kCGColorSpaceSRGB;
    if (@available(macOS 14.0, *)) cfg.ignoreShadowsSingleWindow = YES;
    return cfg;
}
@end

struct MrWindow { void *win; };

MrWindow *mr_window_start(uint32_t window_id, MrWindowFrame cb, void *ctx, double delay_s, char *err, size_t err_len) {
    __block SCShareableContent *content = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *c, NSError *e) {
        content = c;
        dispatch_semaphore_signal(sem);
    }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0 || !content) {
        setErr(err, err_len, @"no answer from ScreenCaptureKit (screen recording not allowed?)");
        return NULL;
    }
    SCWindow *target = nil;
    for (SCWindow *w in content.windows)
        if (w.windowID == window_id) target = w;
    if (!target) {
        setErr(err, err_len, @"the window is gone");
        return NULL;
    }
    MrWin *m = [[MrWin alloc] init];
    m.windowID = window_id;
    m.cb = cb;
    m.ctx = ctx;
    m.delay = delay_s;
    m.ring = [NSMutableArray array];
    m.spans = [NSMutableArray array];
    m.lock = [[NSLock alloc] init];
    m.cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    m.ci = [CIContext contextWithOptions:@{kCIContextWorkingColorSpace: (__bridge id)m.cs}];
    m.queue = dispatch_queue_create("mr.window", DISPATCH_QUEUE_SERIAL);
    m.configured = target.frame.size;
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
    m.stream = [[SCStream alloc] initWithFilter:filter configuration:[MrWin configFor:target.frame.size] delegate:m];
    NSError *aerr = nil;
    if (![m.stream addStreamOutput:m type:SCStreamOutputTypeScreen sampleHandlerQueue:m.queue error:&aerr]) {
        setErr(err, err_len, aerr.localizedDescription);
        return NULL;
    }
    dispatch_async(dispatch_get_main_queue(), ^{ [m setUpReplica]; });
    __block NSError *serr = nil;
    [m.stream startCaptureWithCompletionHandler:^(NSError *e) {
        serr = e;
        dispatch_semaphore_signal(sem);
    }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0 || serr) {
        m.stopped = 1;
        setErr(err, err_len, serr ? serr.localizedDescription : @"the window capture did not start");
        return NULL;
    }
    MrWindow *h = calloc(1, sizeof(MrWindow));
    h->win = (void *)CFBridgingRetain(m);
    return h;
}

static MrWin *winOf(MrWindow *h) { return (__bridge MrWin *)h->win; }

void mr_window_set_delay(MrWindow *h, double delay_s) { if (h) winOf(h).delay = delay_s; }

void mr_window_add_span(MrWindow *h, const float *rects, int n, double from, double to) {
    if (!h) return;
    MrWin *m = winOf(h);
    MrSpan *s = [[MrSpan alloc] init];
    s.from = from;
    s.to = to;
    NSMutableArray *list = [NSMutableArray arrayWithCapacity:n];
    for (int i = 0; i < n; i++) [list addObject:[NSValue valueWithRect:NSMakeRect(rects[i * 4], rects[i * 4 + 1], rects[i * 4 + 2], rects[i * 4 + 3])]];
    s.rects = list;
    [m.lock lock];
    [m.spans addObject:s];
    [m.lock unlock];
}

int mr_window_ok(MrWindow *h) { return h && !winOf(h).failed; }

double mr_host_now(void) { return hostNow(); }

void mr_window_stop(MrWindow *h) {
    if (!h) return;
    MrWin *m = (MrWin *)CFBridgingRelease(h->win);
    m.stopped = 1;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [m.stream stopCaptureWithCompletionHandler:^(NSError *e) { dispatch_semaphore_signal(sem); }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    dispatch_sync(dispatch_get_main_queue(), ^{
        if ([m.link respondsToSelector:@selector(invalidate)]) [m.link invalidate];
        [m.replica orderOut:nil];
        m.layer.contents = nil;
        if (m.outBuf) { CVPixelBufferRelease(m.outBuf); m.outBuf = NULL; }
        m.replica = nil;
    });
    [m.lock lock];
    [m.ring removeAllObjects];
    m.shown = nil;
    [m.lock unlock];
    if (m.inPool) CVPixelBufferPoolRelease(m.inPool);
    if (m.outPool) CVPixelBufferPoolRelease(m.outPool);
    if (m.cs) CGColorSpaceRelease(m.cs);
    free(h);
}
