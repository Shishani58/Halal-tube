// Screen capture (ScreenCaptureKit) and the blur overlay for the "hide on screen" mode. See screen.rs.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct MrScreen MrScreen;

/// Called on a capture queue with a BGRA frame (valid only during the call).
typedef void (*MrScreenFrame)(const uint8_t *bgra, uint32_t width, uint32_t height, uint32_t stride, void *ctx);

/// 1 when the "Screen Recording" permission is granted (does not prompt).
int mr_screen_access(void);
/// Asks for the permission (the system prompt, once); returns whether it is granted right now.
int mr_screen_request(void);

/// Starts capturing the main display at most `max_width` pixels wide, one frame per `interval_s`, without this
/// process's own windows (the overlay must not be seen by the detector). Blocks until it runs (or fails).
/// NULL on failure, with a message in `err`.
MrScreen *mr_screen_start(MrScreenFrame cb, void *ctx, uint32_t max_width, double interval_s, char *err, size_t err_len);
void mr_screen_stop(MrScreen *s);

/// Shows blurred patches over the main display: `n` rects of 4 floats (x, y, w, h), fractions of the screen,
/// origin at the top-left. `n` = 0 hides the overlay. Callable from any thread.
void mr_overlay_set(const float *rects, int n);
