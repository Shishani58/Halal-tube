// "Hide in a window": captures one window and lays a delayed, blurred copy of it exactly over the real one.
// The copy is of the frame `delay` seconds ago, so the blur is put on the very frame it belongs to (the detector
// has had time to look), and the picture can be held back as long as the live audio, so that they match.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t id;
    uint32_t width, height;
    char app[64];
    char title[96];
} MrWindowInfo;

/// The windows on screen that can be chosen (not this process's own, not tiny ones). Returns the count, -1 on failure.
int mr_windows(MrWindowInfo *out, int max);

typedef struct MrWindow MrWindow;

/// A frame for the detector, BGRA at most 1600 px wide, valid during the call; `pts` is on the host clock (see mr_host_now).
typedef void (*MrWindowFrame)(const uint8_t *bgra, uint32_t width, uint32_t height, uint32_t stride, double pts, void *ctx);

/// Starts. NULL on failure, with a message in `err`.
MrWindow *mr_window_start(uint32_t window_id, MrWindowFrame cb, void *ctx, double delay_s, char *err, size_t err_len);
void mr_window_set_delay(MrWindow *w, double delay_s);
/// The frames captured in [from, to] (host clock, seconds) get `n` blurred rects (x, y, w, h, fractions, origin top-left).
void mr_window_add_span(MrWindow *w, const float *rects, int n, double from, double to);
/// 0 once the capture has stopped by itself (the window was closed).
int mr_window_ok(MrWindow *w);
void mr_window_stop(MrWindow *w);
/// The host clock, seconds.
double mr_host_now(void);
