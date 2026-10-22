/** The page a friend opens from a room link: join as a guest, or watch. */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { captureError, openDevice } from "../capture/capture";
import { join, joinCode, joinState, leave, pasteAnswer, readJoinLink } from "../live/join";
import { Icon, Logo } from "./components/Icons";

function Video(props: {
  stream: MediaStream | null;
  muted: boolean;
  mirror?: boolean;
  testid: string;
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = props.stream;
    if (props.stream) void v.play().catch(() => {});
  }, [props.stream]);
  return (
    <video
      ref={ref}
      class={props.mirror ? "join-video mirror" : "join-video"}
      muted={props.muted}
      playsInline
      autoplay
      data-testid={props.testid}
    />
  );
}

function ManualCodes(): JSX.Element {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const code = joinCode.value;
  return (
    <details class="manual" data-testid="manual">
      <summary>Not getting through? Connect with codes</summary>
      <ol class="stack small">
        <li>
          Send this code to the host (by message, for example):
          <div class="code-row">
            <input
              readOnly
              value={code ?? "…"}
              aria-label="Your join code"
              data-testid="join-code"
            />
            <button
              type="button"
              class="btn sm"
              disabled={!code}
              onClick={() => {
                if (!code) return;
                void navigator.clipboard?.writeText(code).then(() => setCopied(true));
              }}
            >
              <Icon name="copy" size={15} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
        <li>
          Paste the host's answer here:
          <form
            class="code-row"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              pasteAnswer(answer).catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
            }}
          >
            <input
              value={answer}
              placeholder="obscura-a.…"
              aria-label="The host's answer code"
              onInput={(e) => setAnswer(e.currentTarget.value)}
              data-testid="answer-input"
            />
            <button
              type="submit"
              class="btn sm"
              disabled={!answer.trim()}
              data-testid="answer-submit"
            >
              Connect
            </button>
          </form>
        </li>
      </ol>
      {error && (
        <p class="error small" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

export function JoinApp(): JSX.Element {
  const link = readJoinLink();
  const [name, setName] = useState("");
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const state = joinState.value;
  const guest = link?.role === "guest";

  // A guest sees themselves before joining; the browser asks for the camera and microphone.
  useEffect(() => {
    if (!guest) return;
    let stream: MediaStream | null = null;
    let gone = false;
    void (async () => {
      const tracks: MediaStreamTrack[] = [];
      const errors: string[] = [];
      for (const kind of ["camera", "mic"] as const) {
        try {
          const s = await openDevice(kind, "", { fps: 30, noise: "browser" });
          tracks.push(...s.getTracks());
        } catch (err) {
          errors.push(`${kind === "camera" ? "Camera" : "Microphone"}: ${captureError(err)}`);
        }
      }
      stream = new MediaStream(tracks);
      if (gone) for (const t of tracks) t.stop();
      else {
        setMedia(stream);
        setMediaError(errors.length ? errors.join(" ") : null);
      }
    })();
    return () => {
      gone = true;
      for (const t of stream?.getTracks() ?? []) t.stop();
      leave();
    };
  }, [guest]);

  useEffect(() => {
    for (const t of media?.getVideoTracks() ?? []) t.enabled = camOn;
  }, [media, camOn]);
  useEffect(() => {
    for (const t of media?.getAudioTracks() ?? []) t.enabled = micOn;
  }, [media, micOn]);

  if (!link) {
    return (
      <main class="fatal">
        <Logo size={40} />
        <h1>This room link is not valid</h1>
        <p class="muted">Ask the host for a new link.</p>
      </main>
    );
  }

  const start = () => {
    void join({ role: link.role, secret: link.secret, name, media: guest ? media : null });
  };
  const connected = state.kind === "connected" ? state : null;
  const waiting = state.kind === "waiting" || state.kind === "connecting";

  return (
    <main class="join" data-testid="join">
      <header class="join-head">
        <Logo size={28} />
        <div>
          <h1>{guest ? "You are invited to a live" : "Watch a live"}</h1>
          <p class="small muted">
            {guest
              ? "Your camera and microphone go straight to the host, peer to peer."
              : "The host's stream comes straight to you, peer to peer."}
          </p>
        </div>
      </header>

      {connected ? (
        <section class="join-live">
          <div class="join-program">
            <Video stream={connected.program} muted={!soundOn} testid="program" />
            {guest && (
              <div class="join-self">
                <Video stream={media} muted mirror testid="self" />
              </div>
            )}
          </div>
          <div class="btn-row join-controls">
            <span class="badge badge-live">LIVE</span>
            {guest && (
              <>
                <button
                  type="button"
                  class="btn sm"
                  aria-pressed={!micOn}
                  onClick={() => setMicOn(!micOn)}
                  data-testid="toggle-mic"
                >
                  <Icon name={micOn ? "mic" : "volumeOff"} size={15} />
                  {micOn ? "Mute" : "Unmute"}
                </button>
                <button
                  type="button"
                  class="btn sm"
                  aria-pressed={!camOn}
                  onClick={() => setCamOn(!camOn)}
                >
                  <Icon name={camOn ? "camera" : "eyeOff"} size={15} />
                  {camOn ? "Camera off" : "Camera on"}
                </button>
              </>
            )}
            <button
              type="button"
              class="btn sm"
              aria-pressed={!soundOn}
              onClick={() => setSoundOn(!soundOn)}
            >
              <Icon name={soundOn ? "volume" : "volumeOff"} size={15} />
              {soundOn ? "Sound on" : "Sound off"}
            </button>
            {document.fullscreenEnabled && (
              <button
                type="button"
                class="btn sm"
                onClick={() =>
                  void document
                    .querySelector<HTMLVideoElement>("[data-testid=program]")
                    ?.requestFullscreen()
                    .catch(() => {})
                }
              >
                <Icon name="pip" size={15} /> Full screen
              </button>
            )}
            <button
              type="button"
              class="btn sm btn-stop"
              onClick={() => leave()}
              data-testid="leave"
            >
              Leave
            </button>
          </div>
        </section>
      ) : (
        <section class="join-setup">
          {guest && (
            <div class="join-preview">
              <Video stream={media} muted mirror testid="preview" />
              {mediaError && <p class="small error">{mediaError}</p>}
            </div>
          )}
          <div class="stack">
            {guest && (
              <label class="field">
                <span class="field-label">Your name</span>
                <input
                  value={name}
                  maxLength={40}
                  placeholder="Shown to the host"
                  disabled={waiting}
                  onInput={(e) => setName(e.currentTarget.value)}
                  data-testid="guest-name"
                />
              </label>
            )}
            {state.kind === "ended" && (
              <p class="small error" role="alert">
                {state.message}
              </p>
            )}
            {waiting ? (
              <>
                <p class="small" role="status" data-testid="join-status">
                  {state.kind === "connecting"
                    ? "Connecting…"
                    : guest
                      ? "Waiting for the host to let you in…"
                      : "Waiting for the host…"}
                  {state.kind === "waiting" && (
                    <span class="muted">
                      {" "}
                      ({state.relays}/{state.total} relays)
                    </span>
                  )}
                </p>
                <button type="button" class="btn" onClick={() => leave()}>
                  Cancel
                </button>
                <ManualCodes />
              </>
            ) : (
              <button
                type="button"
                class="btn btn-primary"
                onClick={start}
                disabled={guest && !media}
                data-testid="join-button"
              >
                <Icon name={guest ? "users" : "play"} size={16} />
                {guest ? "Join" : "Watch"}
              </button>
            )}
            <p class="small muted">
              Connection details go through public relays, encrypted with a key that only this link
              holds. <a href="./">What is obscura?</a>
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
