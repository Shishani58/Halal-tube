// System audio capture on macOS 14.2+: a Core Audio process tap on everything the system plays,
// except this process, read through a private aggregate device. See capture.rs.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct MrTap MrTap;

/// Called on the audio thread with interleaved float samples (`frames` × `channels`).
typedef void (*MrTapCallback)(const float *samples, uint32_t frames, uint32_t channels, void *ctx);

/// Starts capturing. `mute_original`: the system's own output of everything captured is silenced
/// (what is heard is only what the caller plays). The caller must already be an audio client
/// (have opened an output stream) so that it can be excluded from the tap; otherwise returns NULL
/// with `*status` = 1. Returns NULL on failure with the OSStatus (or 1 for "not an audio client yet",
/// 2 for "macOS too old") in `*status` and a message in `err`.
/// `output_name`: the output device whose clock the capture runs on and which the caller plays to
/// (NULL: the system's default output). The tap hears everything the system plays, whichever device it goes to.
MrTap *mr_tap_start(MrTapCallback cb, void *ctx, int mute_original, const char *output_name, double *sample_rate, uint32_t *channels, int32_t *status, char *err, size_t err_len);

/// The rate blocks arrive at now: the aggregate device's clock, which follows the output device and
/// changes when a player switches the device to the rate of its file (0 if unknown).
double mr_tap_rate(MrTap *tap);

void mr_tap_stop(MrTap *tap);
