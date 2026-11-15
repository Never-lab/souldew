// A native host's sound out – see ffaudio.h.
#include "ffaudio.h"
#include "hostio.h"
#include "protocol.h"

#include <stdlib.h>

void ffa_init(struct ff_audio *fa, double sample_rate) {
  free(fa->buf);
  *fa = (struct ff_audio){.rate = sample_rate > 0 ? sample_rate : 32768, .k = 1};
}

/** The frame's sound sped up by fa->k (fractional box filter) into fa->buf; returns how many frames came out. */
static size_t speed_up(struct ff_audio *fa, const int16_t *s, size_t n) {
  if (fa->cap < n + 4) {
    int16_t *b = realloc(fa->buf, (n + 4) * 2 * sizeof *b);
    if (!b) return 0;
    fa->buf = b, fa->cap = n + 4;
  }
  size_t out = 0;
  for (size_t i = 0; i < n; i++) {
    fa->sum[0] += s[i * 2], fa->sum[1] += s[i * 2 + 1];
    fa->cnt++;
    if ((fa->acc += 1) >= fa->k && out < fa->cap) {
      fa->buf[out * 2] = (int16_t)(fa->sum[0] / (double)fa->cnt);
      fa->buf[out * 2 + 1] = (int16_t)(fa->sum[1] / (double)fa->cnt);
      out++;
      fa->acc -= fa->k;
      fa->sum[0] = fa->sum[1] = 0;
      fa->cnt = 0;
    }
  }
  return out;
}

void ffa_frame(struct ff_audio *fa, const int16_t *s, size_t frames, bool turbo, double asked, double now) {
  if (turbo != fa->turbo) { // a fresh start for the sped-up sound: the asked-for speed until it is measured
    fa->turbo = turbo;
    fa->k = turbo ? (asked > FFA_MAX_SPEEDUP ? FFA_MAX_SPEEDUP : asked < 1 ? 1 : asked) : 1;
    fa->acc = fa->sum[0] = fa->sum[1] = 0;
    fa->cnt = 0;
    fa->budget = fa->rate * 0.05;
  }
  if (frames && !turbo) {
    host_send(MSG_AUDIO, s, (uint32_t)(frames * 4));
    fa->budget = 0;
  } else if (frames) {
    // what doesn't fit into real time is left out, in whole frames (a slow sound card would otherwise lag ever more)
    fa->budget += (now - fa->last) * fa->rate;
    if (fa->budget > fa->rate * 0.2) fa->budget = fa->rate * 0.2;
    const size_t m = speed_up(fa, s, frames);
    if (m && fa->budget >= (double)m) {
      fa->budget -= (double)m;
      host_send(MSG_AUDIO, fa->buf, (uint32_t)(m * 4));
    }
  }
  fa->last = now;
}

void ffa_measured(struct ff_audio *fa, double real) {
  if (fa->turbo) fa->k = real < 1 ? 1 : real > FFA_MAX_SPEEDUP ? FFA_MAX_SPEEDUP : real;
}
