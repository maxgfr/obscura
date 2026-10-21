/** Audio of the active scene: a meter, volume, mute and monitor per source. */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { captureErrors, captures, engine, monitors } from "../../studio/engine";
import { activeScene, setLayer } from "../../studio/store";
import { Icon } from "./Icons";

function Meter(props: { source: string }): JSX.Element {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const level = engine?.mixer.level(props.source) ?? 0;
      // Fast attack, slow release, like a hardware meter.
      shown = level > shown ? level : shown * 0.9 + level * 0.1;
      if (bar.current) bar.current.style.transform = `scaleX(${shown.toFixed(3)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.source]);
  return (
    <span class="meter" aria-hidden="true">
      <span class="meter-fill" ref={bar} />
    </span>
  );
}

export function Mixer(): JSX.Element {
  const scene = activeScene.value;
  const live = new Map(captures.value.map((c) => [c.source, c]));
  const mon = monitors.value;
  const channels = scene.layers.filter((l) => l.audio && l.source && live.get(l.source)?.hasAudio);
  // Microphones of this scene that are not on yet: one click away.
  const off = scene.layers.filter((l) => l.kind === "mic" && l.source && !live.has(l.source));
  return (
    <section class="mixer" aria-label="Audio mixer" data-testid="mixer">
      {off.map((l) => (
        <div key={l.id} class="channel off">
          <div class="channel-head">
            <span class="channel-name">{l.name}</span>
          </div>
          <button
            type="button"
            class="btn sm"
            onClick={() => void engine?.open(l)}
            data-testid="mic-on"
          >
            <Icon name="mic" size={15} /> Turn on
          </button>
          {l.source && captureErrors.value[l.source] && (
            <p class="small error">{captureErrors.value[l.source]}</p>
          )}
        </div>
      ))}
      {channels.length === 0 && off.length === 0 ? (
        <p class="empty small">
          No audio in this scene. Add a microphone, or share a tab with its audio.
        </p>
      ) : (
        channels.map((l) => {
          const a = l.audio as NonNullable<typeof l.audio>;
          const source = l.source as string;
          const audible = l.visible && !a.muted;
          return (
            <div key={l.id} class={audible ? "channel" : "channel off"}>
              <div class="channel-head">
                <span class="channel-name">{l.name}</span>
                <span class="tabular small muted">{Math.round(a.gain * 100)}%</span>
              </div>
              <Meter source={source} />
              <div class="channel-controls">
                <button
                  type="button"
                  class="icon-btn sm"
                  aria-pressed={a.muted}
                  aria-label={a.muted ? `Unmute ${l.name}` : `Mute ${l.name}`}
                  title={a.muted ? "Unmute" : "Mute"}
                  onClick={() => setLayer(l.id, { audio: { ...a, muted: !a.muted } })}
                  data-testid="mute"
                >
                  <Icon name={a.muted ? "volumeOff" : "volume"} size={16} />
                </button>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={a.gain}
                  aria-label={`${l.name} volume`}
                  onInput={(e) =>
                    setLayer(l.id, { audio: { ...a, gain: Number(e.currentTarget.value) } })
                  }
                />
                <button
                  type="button"
                  class="icon-btn sm"
                  aria-pressed={mon.has(source)}
                  aria-label={`Monitor ${l.name} in your headphones`}
                  title="Monitor (use headphones)"
                  onClick={() => {
                    const next = new Set(mon);
                    if (next.has(source)) next.delete(source);
                    else next.add(source);
                    monitors.value = next;
                  }}
                >
                  <Icon name="headphones" size={16} />
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
