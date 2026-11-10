#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <unistd.h>
#include "tap.h"

struct MrTap {
    AudioObjectID tap;
    AudioObjectID aggregate;
    AudioDeviceIOProcID proc;
    MrTapCallback cb;
    void *ctx;
    BOOL nonInterleaved;
    uint32_t channels;
    float *scratch;
    uint32_t scratchFrames;
};

static void fail(char *err, size_t n, int32_t *status, int32_t code, const char *what) {
    if (status) *status = code;
    if (err && n) snprintf(err, n, "%s (OSStatus %d)", what, code);
}

static BOOL getProp(AudioObjectID obj, AudioObjectPropertySelector sel, UInt32 qsize, const void *q, void *out, UInt32 *size) {
    AudioObjectPropertyAddress a = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    return AudioObjectGetPropertyData(obj, &a, qsize, q, size, out) == noErr;
}

/// The UID of the output device called `name` (as listed by Core Audio), or nil.
static NSString *outputUIDNamed(const char *name) {
    UInt32 size = 0;
    AudioObjectPropertyAddress all = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &all, 0, NULL, &size) != noErr || size == 0) return nil;
    AudioObjectID *ids = malloc(size);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &all, 0, NULL, &size, ids) != noErr) { free(ids); return nil; }
    NSString *want = [NSString stringWithUTF8String:name];
    NSString *found = nil;
    for (UInt32 i = 0; i < size / sizeof(AudioObjectID) && !found; i++) {
        CFStringRef n = NULL;
        UInt32 s = sizeof(n);
        AudioObjectPropertyAddress na = {kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
        if (AudioObjectGetPropertyData(ids[i], &na, 0, NULL, &s, &n) != noErr || !n) continue;
        BOOL match = [(__bridge NSString *)n isEqualToString:want];
        CFRelease(n);
        if (!match) continue;
        UInt32 cs = 0;
        AudioObjectPropertyAddress out = {kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain};
        if (AudioObjectGetPropertyDataSize(ids[i], &out, 0, NULL, &cs) != noErr || cs == 0) continue;
        CFStringRef uid = NULL;
        s = sizeof(uid);
        if (getProp(ids[i], kAudioDevicePropertyDeviceUID, 0, NULL, &uid, &s) && uid) found = (__bridge_transfer NSString *)uid;
    }
    free(ids);
    return found;
}

MrTap *mr_tap_start(MrTapCallback cb, void *ctx, int mute_original, const char *output_name, double *sample_rate, uint32_t *channels, int32_t *status, char *err, size_t err_len) {
    if (@available(macOS 14.2, *)) {
        // our own audio object: the tap must not hear what this process plays
        pid_t pid = getpid();
        AudioObjectID self = kAudioObjectUnknown;
        UInt32 size = sizeof(self);
        if (!getProp(kAudioObjectSystemObject, kAudioHardwarePropertyTranslatePIDToProcessObject, sizeof(pid), &pid, &self, &size) || self == kAudioObjectUnknown) {
            fail(err, err_len, status, 1, "this process is not an audio client yet: open an output stream first");
            return NULL;
        }
        CATapDescription *desc = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[ @(self) ]];
        desc.name = @"Music Remover";
        desc.UUID = [NSUUID UUID];
        desc.privateTap = YES;
        desc.muteBehavior = mute_original ? CATapMuted : CATapUnmuted;

        AudioObjectID tap = kAudioObjectUnknown;
        OSStatus st = AudioHardwareCreateProcessTap(desc, &tap);
        if (st != noErr) {
            fail(err, err_len, status, st, "cannot create the audio tap (system audio recording not allowed?)");
            return NULL;
        }

        // the aggregate device needs a clock: the chosen output device, else the default one
        NSString *outUID = (output_name && output_name[0]) ? outputUIDNamed(output_name) : nil;
        if (output_name && output_name[0] && !outUID) {
            AudioHardwareDestroyProcessTap(tap);
            fail(err, err_len, status, -3, "the chosen output device was not found");
            return NULL;
        }
        if (!outUID) {
            AudioObjectID outDev = kAudioObjectUnknown;
            size = sizeof(outDev);
            CFStringRef uidRef = NULL;
            UInt32 usize = sizeof(uidRef);
            if (!getProp(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultSystemOutputDevice, 0, NULL, &outDev, &size) ||
                !getProp(outDev, kAudioDevicePropertyDeviceUID, 0, NULL, &uidRef, &usize) || !uidRef) {
                AudioHardwareDestroyProcessTap(tap);
                fail(err, err_len, status, -1, "no default output device");
                return NULL;
            }
            outUID = (__bridge_transfer NSString *)uidRef;
        }
        NSString *tapUID = desc.UUID.UUIDString;
        NSDictionary *dict = @{
            @kAudioAggregateDeviceNameKey: @"Music Remover tap",
            @kAudioAggregateDeviceUIDKey: [NSUUID UUID].UUIDString,
            @kAudioAggregateDeviceMainSubDeviceKey: outUID,
            @kAudioAggregateDeviceIsPrivateKey: @YES,
            @kAudioAggregateDeviceIsStackedKey: @NO,
            @kAudioAggregateDeviceTapAutoStartKey: @YES,
            @kAudioAggregateDeviceSubDeviceListKey: @[ @{ @kAudioSubDeviceUIDKey: outUID } ],
            @kAudioAggregateDeviceTapListKey: @[ @{ @kAudioSubTapDriftCompensationKey: @YES, @kAudioSubTapUIDKey: tapUID } ],
        };
        AudioObjectID agg = kAudioObjectUnknown;
        st = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)dict, &agg);
        if (st != noErr) {
            AudioHardwareDestroyProcessTap(tap);
            fail(err, err_len, status, st, "cannot create the aggregate device");
            return NULL;
        }

        AudioStreamBasicDescription fmt;
        size = sizeof(fmt);
        if (!getProp(tap, kAudioTapPropertyFormat, 0, NULL, &fmt, &size) || fmt.mFormatID != kAudioFormatLinearPCM || !(fmt.mFormatFlags & kAudioFormatFlagIsFloat)) {
            AudioHardwareDestroyAggregateDevice(agg);
            AudioHardwareDestroyProcessTap(tap);
            fail(err, err_len, status, -2, "the tap's format is not float PCM");
            return NULL;
        }

        MrTap *t = calloc(1, sizeof(MrTap));
        t->tap = tap;
        t->aggregate = agg;
        t->cb = cb;
        t->ctx = ctx;
        t->channels = fmt.mChannelsPerFrame;
        t->nonInterleaved = (fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
        // The rate the blocks really arrive at is the aggregate device's clock (the output device's),
        // which can differ from the rate the tap's format property claims (48 kHz claimed, 44.1 kHz
        // delivered): trust the device.
        Float64 deviceRate = 0;
        UInt32 rsize = sizeof(deviceRate);
        if (!getProp(agg, kAudioDevicePropertyNominalSampleRate, 0, NULL, &deviceRate, &rsize) || deviceRate < 8000) deviceRate = fmt.mSampleRate;
        if (sample_rate) *sample_rate = deviceRate;
        if (channels) *channels = fmt.mChannelsPerFrame;

        st = AudioDeviceCreateIOProcIDWithBlock(&t->proc, agg, NULL, ^(const AudioTimeStamp *now, const AudioBufferList *in, const AudioTimeStamp *inT, AudioBufferList *out, const AudioTimeStamp *outT) {
            if (!in || in->mNumberBuffers == 0) return;
            if (!t->nonInterleaved) {
                const AudioBuffer *b = &in->mBuffers[0];
                uint32_t ch = b->mNumberChannels ? b->mNumberChannels : t->channels;
                if (b->mData && ch) t->cb((const float *)b->mData, b->mDataByteSize / (sizeof(float) * ch), ch, t->ctx);
                return;
            }
            // planar: interleave into a scratch buffer (allocated once, grown only if a callback is bigger)
            uint32_t ch = in->mNumberBuffers, frames = in->mBuffers[0].mDataByteSize / sizeof(float);
            if (t->scratchFrames < frames * ch) {
                free(t->scratch);
                t->scratch = malloc(sizeof(float) * frames * ch);
                t->scratchFrames = frames * ch;
            }
            for (uint32_t c = 0; c < ch; c++) {
                const float *p = (const float *)in->mBuffers[c].mData;
                for (uint32_t i = 0; i < frames; i++) t->scratch[i * ch + c] = p[i];
            }
            t->cb(t->scratch, frames, ch, t->ctx);
        });
        if (st == noErr) st = AudioDeviceStart(agg, t->proc);
        if (st != noErr) {
            mr_tap_stop(t);
            fail(err, err_len, status, st, "cannot start reading the tap");
            return NULL;
        }
        if (status) *status = 0;
        return t;
    }
    fail(err, err_len, status, 2, "system audio capture needs macOS 14.2 or newer");
    return NULL;
}

double mr_tap_rate(MrTap *t) {
    if (!t) return 0;
    Float64 rate = 0;
    UInt32 size = sizeof(rate);
    return getProp(t->aggregate, kAudioDevicePropertyNominalSampleRate, 0, NULL, &rate, &size) ? rate : 0;
}

void mr_tap_stop(MrTap *t) {
    if (!t) return;
    if (@available(macOS 14.2, *)) {
        if (t->proc) {
            AudioDeviceStop(t->aggregate, t->proc);
            AudioDeviceDestroyIOProcID(t->aggregate, t->proc);
        }
        if (t->aggregate != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(t->aggregate);
        if (t->tap != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(t->tap);
    }
    free(t->scratch);
    free(t);
}
