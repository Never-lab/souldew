// A native host's sound out, frame by frame (AUDIO): as the console made it at normal speed; while fast-forwarding
// sped up by the speed really reached (time-compressed with a box filter, at most 16×, as RetroArch's
// audio_fastforward_speedup) and never more than real time – souldew's turbo mixer (web/lib/turboaudio.mjs) slows it
// down again or plays the game's music instead (Settings › sound while fast-forwarding).
#ifndef SOULDEW_FFAUDIO_H
#define SOULDEW_FFAUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FFA_MAX_SPEEDUP 16

struct ff_audio {
  double rate;       // stereo frames per second
  double k;          // the speed-up: input frames per output frame
  double acc, sum[2];
  size_t cnt;
  double budget;     // output frames real time still has room for
  double last;       // when the last frame's sound came
  bool turbo;
  int16_t *buf;
  size_t cap;
};

void ffa_init(struct ff_audio *fa, double sample_rate);
/**
 * The console's sound rate now (a GBA game switches its sound hardware to 65536 Hz after it boots – SOUNDBIAS): when it
 * differs from the one announced, the sound starts afresh at the new rate and the page hears of it (EVENT audioRate
 * {sampleRate}: it re-creates its audio context, as for a new loaded event's rate).
 */
void ffa_rate(struct ff_audio *fa, double sample_rate);
/**
 * One emulated frame's sound (`frames` interleaved stereo frames) out as AUDIO. `turbo`: fast-forwarding at `asked`
 * (the speed souldew asked for: the speed-up until ffa_measured knows better). `now`: host_now().
 */
void ffa_frame(struct ff_audio *fa, const int16_t *s, size_t frames, bool turbo, double asked, double now);
/** The speed reached (frames per second over the system's rate), measured while fast-forwarding. */
void ffa_measured(struct ff_audio *fa, double real_speed);

#ifdef __cplusplus
}
#endif

#endif
